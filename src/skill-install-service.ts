import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { validateSkillId, validateSkillPath } from './skill-utils.js';
import {
  runCommandWithDirectoryQuota,
  installSkillDirectoriesTransactionally,
} from './skill-import-service.js';
import {
  repairCapabilityRuntimeSafetyBlock,
  mutateCapabilityAroundRuntimeQuiesce,
  CapabilityRuntimeCommitError,
} from './capability-runtime-mutation.js';
import { WorkspaceRuntimeQuiesceError } from './agent-profile-runtime.js';
import {
  withCapabilityScopeLocks,
  userCapabilityLockKey,
} from './capability-lock.js';
import {
  listAgentProfilesForUser,
  storeMessageDirect,
  ensureChatExists,
} from './db.js';
import { getChannelTurnRun } from './channel-reliability-store.js';

export const MAX_SKILL_INSTALL_BYTES = 50 * 1024 * 1024; // 50MB
export const SKILL_ARCHIVE_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB

export interface SkillsManifest {
  skills: Record<
    string,
    {
      packageName?: string;
      installedAt: string;
      source: string;
      sourceUrl?: string;
      version?: string;
    }
  >;
}

export function getSkillsManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.skills-manifest.json');
}

export function readSkillsManifest(userId: string): SkillsManifest {
  try {
    const data = fs.readFileSync(getSkillsManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { skills: {} };
  }
}

export function writeSkillsManifest(
  userId: string,
  manifest: SkillsManifest,
): void {
  const manifestPath = getSkillsManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2));
    fs.renameSync(temporaryPath, manifestPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

import {
  type CapabilityMutationRecord,
  bindCapabilityMutationDatabase,
  createCapabilityMutationSchema,
  getCapabilityMutationRequest,
  recordCapabilityMutationRequest,
  claimCapabilityMutation,
  updateCapabilityMutationRequest,
  listPendingCapabilityMutations,
} from './capability-mutation-store.js';

export {
  type CapabilityMutationRecord,
  bindCapabilityMutationDatabase,
  createCapabilityMutationSchema,
  getCapabilityMutationRequest,
  recordCapabilityMutationRequest,
  claimCapabilityMutation,
  updateCapabilityMutationRequest,
  listPendingCapabilityMutations,
};

export interface SkillInstallResult {
  success: boolean;
  accepted?: boolean;
  requestId?: string;
  installed?: string[];
  message?: string;
  error?: string;
  retryable?: boolean;
  invalidatedRuntimeJids?: number;
}

export interface SkillDeleteResult {
  success: boolean;
  accepted?: boolean;
  requestId?: string;
  message?: string;
  error?: string;
  retryable?: boolean;
  invalidatedRuntimeJids?: number;
}

// --- User Skill Locks & Mutation Utilities ---

const skillMutationLocks = new Map<
  string,
  { tail: Promise<void>; references: number }
>();

async function withPrivateUserSkillMutationLock<T>(
  userId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  let state = skillMutationLocks.get(userId);
  if (!state) {
    state = { tail: Promise.resolve(), references: 0 };
    skillMutationLocks.set(userId, state);
  }
  state.references += 1;
  const previous = state.tail.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    state.references -= 1;
    if (state.references === 0 && skillMutationLocks.get(userId) === state) {
      skillMutationLocks.delete(userId);
    }
  }
}

export async function withUserSkillMutationLock<T>(
  userId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withCapabilityScopeLocks([userCapabilityLockKey(userId)], () =>
    withPrivateUserSkillMutationLock(userId, fn),
  );
}

export async function withUserSkillRuntimeMutation<T>(
  userId: string,
  ids: string[] | undefined,
  reason: string,
  mutation: () => Promise<T> | T,
): Promise<{ value: T; invalidatedRuntimeJids: number }> {
  return withUserSkillMutationLock(userId, async () => {
    const impact = { kind: 'skills' as const, ownerUserId: userId, ids };
    await repairCapabilityRuntimeSafetyBlock(impact, reason);
    return mutateCapabilityAroundRuntimeQuiesce(impact, reason, mutation);
  });
}

export function skillRuntimeMutationFailure(error: unknown, action: string) {
  if (error instanceof WorkspaceRuntimeQuiesceError) {
    return {
      error: error.persisted
        ? `${action} was saved, but runtime cleanup failed; retry the request`
        : `Failed to stop affected workspaces; ${action} was not saved`,
      persisted: error.persisted,
      retryable: true,
    };
  }
  if (error instanceof CapabilityRuntimeCommitError) {
    return {
      error: `${action} has an uncertain commit outcome; retry the request to finish fail-closed cleanup`,
      persisted: 'unknown',
      retryable: true,
    };
  }
  return null;
}

export function getUserSkillsDir(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

export function validateSafeHttpsUrl(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') {
      return 'Only https: URLs are permitted for remote skill installation';
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return 'Private or link-local network hosts are not permitted';
    }
    return null;
  } catch {
    return 'Malformed URL';
  }
}

function updateSkillsManifest(
  userId: string,
  packageName: string,
  installedSkillIds: string[],
): void {
  const manifest = readSkillsManifest(userId);
  const now = new Date().toISOString();
  for (const id of installedSkillIds) {
    manifest.skills[id] = {
      packageName,
      installedAt: now,
      source: 'skills.sh',
    };
  }
  writeSkillsManifest(userId, manifest);
}

export function referencedByCustomSkillProfiles(
  userId: string,
  skillIds: Iterable<string>,
): Array<{ id: string; name: string; skillIds: string[] }> {
  const candidates = new Set(skillIds);
  return listAgentProfilesForUser(userId)
    .filter((profile: any) => profile.runtime_policy.skills.mode === 'custom')
    .map((profile: any) => ({
      id: profile.id,
      name: profile.name,
      skillIds: profile.runtime_policy.skills.ids.filter((id: string) =>
        candidates.has(id),
      ),
    }))
    .filter((profile: any) => profile.skillIds.length > 0);
}

// --- Core Unlocked Mutation Functions ---

export async function installSkillForUserUnlocked(
  userId: string,
  pkg: string,
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  const isNpmName = /^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg);
  const isUrl = /^https?:\/\//.test(pkg);
  if (!isNpmName && !isUrl) {
    return { success: false, error: 'Invalid package name format' };
  }
  if (isUrl) {
    const reason = validateSafeHttpsUrl(pkg);
    if (reason) {
      return { success: false, error: `Refused skill URL: ${reason}` };
    }
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
  const tempSkillsDir = path.join(tempHome, '.claude', 'skills');
  fs.mkdirSync(tempSkillsDir, { recursive: true });

  try {
    await runCommandWithDirectoryQuota({
      command: 'npx',
      args: [
        '-y',
        'skills',
        'add',
        pkg,
        '--global',
        '--yes',
        '-a',
        'claude-code',
      ],
      watchDir: tempHome,
      maxBytes: MAX_SKILL_INSTALL_BYTES,
      timeoutMs: 60_000,
      label: 'Skill package installation',
      env: { ...process.env, HOME: tempHome },
    });

    const installedEntries: string[] = [];
    if (fs.existsSync(tempSkillsDir)) {
      for (const entry of fs.readdirSync(tempSkillsDir, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          installedEntries.push(entry.name);
        }
      }
    }

    if (installedEntries.length === 0) {
      return {
        success: false,
        error: 'No skills were installed — package may be invalid',
      };
    }

    const userDir = getUserSkillsDir(userId);
    installSkillDirectoriesTransactionally(
      installedEntries.map((id) => ({
        id,
        dir: fs.realpathSync(path.join(tempSkillsDir, id)),
      })),
      userDir,
      true,
      (installedIds) => updateSkillsManifest(userId, pkg, installedIds),
    );

    return { success: true, installed: installedEntries };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function deleteSkillForUserUnlocked(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  const referencedByProfiles = referencedByCustomSkillProfiles(userId, [
    skillId,
  ]);
  if (referencedByProfiles.length > 0) {
    return {
      success: false,
      error: `以下智能体正在使用该 Skill：${referencedByProfiles
        .map((profile) => profile.name)
        .join(', ')}`,
    };
  }

  const userDir = getUserSkillsDir(userId);
  const skillDir = path.join(userDir, skillId);

  if (!fs.existsSync(skillDir)) {
    // Idempotent deletion: if already absent from disk, ensure manifest is cleaned and return success
    const previousManifest = readSkillsManifest(userId);
    if (skillId in previousManifest.skills) {
      const nextManifest = structuredClone(previousManifest);
      delete nextManifest.skills[skillId];
      writeSkillsManifest(userId, nextManifest);
    }
    return { success: true };
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return { success: false, error: 'Invalid skill path' };
  }

  const backupDir = path.join(
    userDir,
    `.delete-${skillId}-${process.pid}-${Date.now()}`,
  );
  const previousManifest = readSkillsManifest(userId);
  try {
    fs.renameSync(skillDir, backupDir);
    const nextManifest = structuredClone(previousManifest);
    delete nextManifest.skills[skillId];
    writeSkillsManifest(userId, nextManifest);
    fs.rmSync(backupDir, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    try {
      if (fs.existsSync(backupDir) && !fs.existsSync(skillDir)) {
        fs.renameSync(backupDir, skillDir);
      }
      writeSkillsManifest(userId, previousManifest);
    } catch {
      /* preserve original */
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export const skillMutationExecutor = {
  installSkillForUserUnlocked,
  deleteSkillForUserUnlocked,
};

// --- Application Service Entry Points ---

export async function installSkillForUser(
  userId: string,
  pkg: string,
  options?: {
    requestId?: string;
    sourceGroup?: string;
    groupFolder?: string;
    sessionId?: string;
    inputTurnId?: string;
    isAgentCaller?: boolean;
  },
): Promise<SkillInstallResult> {
  const isAgentCaller = Boolean(
    options?.isAgentCaller || options?.sourceGroup || options?.groupFolder,
  );
  const requestId =
    options?.requestId ||
    `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // If called by an active Agent in its turn, register the mutation and defer execution to turn boundary.
  if (isAgentCaller) {
    const existing = getCapabilityMutationRequest(requestId);
    if (existing) {
      // Recheck identity bindings
      if (
        existing.userId !== userId ||
        existing.action !== 'install' ||
        existing.target !== pkg
      ) {
        return {
          success: false,
          error: `Request ID conflict: requestId "${requestId}" already belongs to a different operation or identity`,
        };
      }
      if (existing.status === 'applied') {
        let installed: string[] = [];
        try {
          installed = existing.resultJson
            ? JSON.parse(existing.resultJson)
            : [];
        } catch {
          /* ignore */
        }
        return {
          success: true,
          accepted: false,
          requestId,
          installed,
          message: `Skill package "${pkg}" is already installed.`,
        };
      }
      if (existing.status === 'failed') {
        return {
          success: false,
          accepted: false,
          requestId,
          error: existing.error || 'Skill installation failed',
        };
      }
      return {
        success: true,
        accepted: true,
        requestId,
        message: `Skill installation accepted for "${pkg}" and will be applied at turn completion.`,
      };
    }

    recordCapabilityMutationRequest({
      requestId,
      userId,
      sourceGroup: options?.sourceGroup ?? null,
      groupFolder: options?.groupFolder ?? null,
      sessionId: options?.sessionId ?? null,
      inputTurnId: options?.inputTurnId ?? null,
      capabilityKind: 'skills',
      action: 'install',
      target: pkg,
      status: 'accepted',
    });

    logger.info(
      {
        userId,
        pkg,
        requestId,
        sessionId: options?.sessionId,
        inputTurnId: options?.inputTurnId,
      },
      'Skill installation request accepted for turn-boundary execution',
    );

    return {
      success: true,
      accepted: true,
      requestId,
      message: `Skill installation accepted for "${pkg}" and will take effect at the turn completion boundary.`,
    };
  }

  // Non-agent caller (e.g. Web UI HTTP endpoint): synchronous installation with runtime quiesce
  try {
    const result = await withUserSkillRuntimeMutation(
      userId,
      undefined,
      'Skill package installation changed managed capabilities',
      () => skillMutationExecutor.installSkillForUserUnlocked(userId, pkg),
    );

    if (options?.requestId) {
      const isSuccess = Boolean(result.value.success);
      recordCapabilityMutationRequest({
        requestId: options.requestId,
        userId,
        sourceGroup: options.sourceGroup ?? null,
        groupFolder: options.groupFolder ?? null,
        sessionId: options.sessionId ?? null,
        inputTurnId: options.inputTurnId ?? null,
        capabilityKind: 'skills',
        action: 'install',
        target: pkg,
        status: isSuccess ? 'applied' : 'failed',
        resultJson: isSuccess
          ? JSON.stringify(result.value.installed ?? [])
          : null,
        error: isSuccess ? null : result.value.error || 'Installation failed',
        appliedAt: isSuccess ? new Date().toISOString() : null,
      });
    }

    return {
      ...result.value,
      invalidatedRuntimeJids: result.invalidatedRuntimeJids,
    };
  } catch (error) {
    const failure = skillRuntimeMutationFailure(error, 'Skill installation');
    const errMsg =
      failure?.error ??
      (error instanceof Error
        ? error.message
        : 'Failed to install Skill safely');
    if (options?.requestId) {
      recordCapabilityMutationRequest({
        requestId: options.requestId,
        userId,
        sourceGroup: options.sourceGroup ?? null,
        groupFolder: options.groupFolder ?? null,
        sessionId: options.sessionId ?? null,
        inputTurnId: options.inputTurnId ?? null,
        capabilityKind: 'skills',
        action: 'install',
        target: pkg,
        status: 'failed',
        error: errMsg,
      });
    }
    return {
      success: false,
      error: errMsg,
      retryable: failure?.retryable ?? true,
    };
  }
}

export async function deleteSkillForUser(
  userId: string,
  skillId: string,
  options?: {
    requestId?: string;
    sourceGroup?: string;
    groupFolder?: string;
    sessionId?: string;
    inputTurnId?: string;
    isAgentCaller?: boolean;
  },
): Promise<SkillDeleteResult> {
  const isAgentCaller = Boolean(
    options?.isAgentCaller || options?.sourceGroup || options?.groupFolder,
  );
  const requestId =
    options?.requestId ||
    `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (isAgentCaller) {
    const existing = getCapabilityMutationRequest(requestId);
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.action !== 'uninstall' ||
        existing.target !== skillId
      ) {
        return {
          success: false,
          error: `Request ID conflict: requestId "${requestId}" already belongs to a different operation or identity`,
        };
      }
      if (existing.status === 'applied') {
        return {
          success: true,
          accepted: false,
          requestId,
          message: `Skill "${skillId}" was uninstalled.`,
        };
      }
      if (existing.status === 'failed') {
        return {
          success: false,
          accepted: false,
          requestId,
          error: existing.error || 'Skill uninstallation failed',
        };
      }
      return {
        success: true,
        accepted: true,
        requestId,
        message: `Skill uninstallation accepted for "${skillId}" and will be applied at turn completion.`,
      };
    }

    recordCapabilityMutationRequest({
      requestId,
      userId,
      sourceGroup: options?.sourceGroup ?? null,
      groupFolder: options?.groupFolder ?? null,
      sessionId: options?.sessionId ?? null,
      inputTurnId: options?.inputTurnId ?? null,
      capabilityKind: 'skills',
      action: 'uninstall',
      target: skillId,
      status: 'accepted',
    });

    logger.info(
      {
        userId,
        skillId,
        requestId,
        sessionId: options?.sessionId,
        inputTurnId: options?.inputTurnId,
      },
      'Skill uninstallation request accepted for turn-boundary execution',
    );

    return {
      success: true,
      accepted: true,
      requestId,
      message: `Skill uninstallation accepted for "${skillId}" and will take effect at the turn completion boundary.`,
    };
  }

  // Non-agent caller: synchronous uninstallation with runtime quiesce
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  try {
    const result = await withUserSkillRuntimeMutation(
      userId,
      [skillId],
      'Skill deletion changed managed capabilities',
      () => skillMutationExecutor.deleteSkillForUserUnlocked(userId, skillId),
    );

    if (options?.requestId) {
      const isSuccess = Boolean(result.value.success);
      recordCapabilityMutationRequest({
        requestId: options.requestId,
        userId,
        sourceGroup: options.sourceGroup ?? null,
        groupFolder: options.groupFolder ?? null,
        sessionId: options.sessionId ?? null,
        inputTurnId: options.inputTurnId ?? null,
        capabilityKind: 'skills',
        action: 'uninstall',
        target: skillId,
        status: isSuccess ? 'applied' : 'failed',
        error: isSuccess ? null : result.value.error || 'Uninstallation failed',
        appliedAt: isSuccess ? new Date().toISOString() : null,
      });
    }

    return {
      ...result.value,
      invalidatedRuntimeJids: result.invalidatedRuntimeJids,
    };
  } catch (error) {
    const failure = skillRuntimeMutationFailure(error, 'Skill deletion');
    const errMsg =
      failure?.error ??
      (error instanceof Error
        ? error.message
        : 'Failed to delete Skill safely');
    if (options?.requestId) {
      recordCapabilityMutationRequest({
        requestId: options.requestId,
        userId,
        sourceGroup: options.sourceGroup ?? null,
        groupFolder: options.groupFolder ?? null,
        sessionId: options.sessionId ?? null,
        inputTurnId: options.inputTurnId ?? null,
        capabilityKind: 'skills',
        action: 'uninstall',
        target: skillId,
        status: 'failed',
        error: errMsg,
      });
    }
    return {
      success: false,
      error: errMsg,
      retryable: failure?.retryable ?? true,
    };
  }
}

/**
 * Record an internal system message visible in the conversation transcript
 * (not forwarded to external IM channels).
 */
function recordMutationCompletionNotice(item: CapabilityMutationRecord): void {
  const targetChatJid =
    item.sourceGroup ||
    (item.groupFolder ? `web:${item.groupFolder}` : undefined);
  if (!targetChatJid) return;

  try {
    const noticeContent =
      item.status === 'applied'
        ? `[系统通知] Skill "${item.target}" 已成功${item.action === 'install' ? '安装' : '卸载'}并生效。`
        : `[系统通知] Skill "${item.target}" ${item.action === 'install' ? '安装' : '卸载'}失败: ${item.error || '未知错误'}`;

    ensureChatExists(targetChatJid);
    storeMessageDirect(
      `notice-${item.requestId}`,
      targetChatJid,
      'system',
      'System',
      noticeContent,
      new Date().toISOString(),
      true,
      {
        meta: { sourceKind: 'capability_mutation_notice' } as any,
      },
    );
  } catch (err) {
    logger.debug(
      { err, requestId: item.requestId },
      'Could not record mutation notice message',
    );
  }
}

/**
 * Execute all pending or accepted capability mutations at a safe boundary (turn completion or restart).
 * Uses atomic CAS claim to ensure concurrent callers execute each mutation exactly once.
 */
export async function applyPendingCapabilityMutations(filter?: {
  groupFolder?: string;
  sessionId?: string;
  inputTurnId?: string;
  userId?: string;
}): Promise<{ applied: number; failed: number; skipped: number }> {
  const pending = listPendingCapabilityMutations(filter);
  if (pending.length === 0) {
    return { applied: 0, failed: 0, skipped: 0 };
  }

  let applied = 0;
  let failed = 0;
  let skipped = 0;
  const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;

  for (const candidate of pending) {
    // When running global recovery (no turn correlation provided), skip mutations whose associated turn is still actively running with valid lease
    if (!filter?.inputTurnId && !filter?.sessionId && candidate.inputTurnId) {
      try {
        const turn = getChannelTurnRun(candidate.inputTurnId);
        if (
          turn &&
          ['running', 'finalizing'].includes(turn.status) &&
          turn.leaseOwner !== null &&
          turn.leaseExpiresAt !== null &&
          turn.leaseExpiresAt > new Date().toISOString()
        ) {
          skipped++;
          continue;
        }
      } catch {
        /* ignore if reliability database is uninitialized in unit test */
      }
    }

    // Atomic CAS claim to guarantee single execution under concurrency
    const claimed = claimCapabilityMutation(candidate.requestId, workerId);
    if (!claimed) {
      skipped++;
      continue;
    }

    const item = claimed;
    try {
      if (item.action === 'install') {
        const result = await withUserSkillRuntimeMutation(
          item.userId,
          undefined,
          'Skill package installation changed managed capabilities',
          () =>
            skillMutationExecutor.installSkillForUserUnlocked(
              item.userId,
              item.target,
            ),
        );
        if (result.value.success) {
          const updated = updateCapabilityMutationRequest(item.requestId, {
            status: 'applied',
            expectedClaimOwner: workerId,
            resultJson: JSON.stringify(result.value.installed ?? []),
            appliedAt: new Date().toISOString(),
          });
          if (updated) {
            applied++;
            recordMutationCompletionNotice({ ...item, status: 'applied' });
            logger.info(
              {
                requestId: item.requestId,
                pkg: item.target,
                userId: item.userId,
              },
              'Pending skill installation successfully applied at turn boundary',
            );
          } else {
            skipped++;
            logger.warn(
              { requestId: item.requestId, workerId },
              'Capability mutation claim was preempted or lost before applied commit',
            );
          }
        } else {
          const updated = updateCapabilityMutationRequest(item.requestId, {
            status: 'failed',
            expectedClaimOwner: workerId,
            error: result.value.error || 'Installation failed',
          });
          if (updated) {
            failed++;
            recordMutationCompletionNotice({
              ...item,
              status: 'failed',
              error: result.value.error || 'Installation failed',
            });
          }
        }
      } else if (item.action === 'uninstall') {
        const result = await withUserSkillRuntimeMutation(
          item.userId,
          [item.target],
          'Skill deletion changed managed capabilities',
          () =>
            skillMutationExecutor.deleteSkillForUserUnlocked(
              item.userId,
              item.target,
            ),
        );
        if (result.value.success) {
          const updated = updateCapabilityMutationRequest(item.requestId, {
            status: 'applied',
            expectedClaimOwner: workerId,
            appliedAt: new Date().toISOString(),
          });
          if (updated) {
            applied++;
            recordMutationCompletionNotice({ ...item, status: 'applied' });
            logger.info(
              {
                requestId: item.requestId,
                skillId: item.target,
                userId: item.userId,
              },
              'Pending skill uninstallation successfully applied at turn boundary',
            );
          } else {
            skipped++;
            logger.warn(
              { requestId: item.requestId, workerId },
              'Capability mutation claim was preempted or lost before applied commit',
            );
          }
        } else {
          const updated = updateCapabilityMutationRequest(item.requestId, {
            status: 'failed',
            expectedClaimOwner: workerId,
            error: result.value.error || 'Uninstallation failed',
          });
          if (updated) {
            failed++;
            recordMutationCompletionNotice({
              ...item,
              status: 'failed',
              error: result.value.error || 'Uninstallation failed',
            });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // If postcommit quiesce failed, mark as quiesce_failed for bounded convergence instead of hard failure
      const isQuiescePersisted =
        error instanceof WorkspaceRuntimeQuiesceError && error.persisted;
      const nextStatus = isQuiescePersisted ? 'quiesce_failed' : 'failed';

      const updated = updateCapabilityMutationRequest(item.requestId, {
        status: nextStatus,
        expectedClaimOwner: workerId,
        error: message,
      });

      if (updated) {
        if (isQuiescePersisted) {
          logger.warn(
            { requestId: item.requestId, err: error },
            'Capability mutation committed but post-commit quiesce failed; marked for convergence',
          );
        } else {
          failed++;
          recordMutationCompletionNotice({
            ...item,
            status: 'failed',
            error: message,
          });
          logger.error(
            { requestId: item.requestId, err: error },
            'Failed applying pending capability mutation at turn boundary',
          );
        }
      }
    }
  }

  return { applied, failed, skipped };
}
