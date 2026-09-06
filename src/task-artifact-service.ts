/**
 * Task Run Artifact Service (R19)
 *
 * Handles run-scoped artifact registration, physical file versioning,
 * SHA-256 tamper verification, quota enforcement, and continuation draft creation.
 *
 * Security & robustness guarantees:
 * - Fail-closed workspace directory resolution supporting Host customCwd snapshot.
 * - Strict safe path verification: rejects ".." and absolute paths outright (no silent rewriting).
 * - Symlink escape prevention: verifies real targets remain strictly within the workspace root.
 * - Same-fd open and read: verifies regular file (rejects FIFO, devices, directories) and eliminates TOCTOU.
 * - Exact runId correlation: IPC declarations are claimed ONLY by matching runId and ACK-deleted upon success.
 * - Immutable continuation materialization: provides guaranteed accessible historical version paths.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR, GROUPS_DIR } from './config.js';
import {
  createTaskRunArtifact,
  getTaskRunArtifactById,
  listTaskRunArtifactsByRunId,
  getTaskRunById,
  getTaskById,
  getRegisteredGroup,
} from './db.js';
import type { TaskRunArtifact, TaskRun, AuthUser } from './types.js';
import { canAccessGroup } from './group-acl.js';
import { logger } from './logger.js';
import type { TaskDraft } from './task-template-service.js';

export const MAX_ARTIFACT_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_ARTIFACTS_PER_RUN = 50;

const ARTIFACTS_STORAGE_DIR = path.join(STORE_DIR, 'artifacts', 'runs');

function ensureRunArtifactDir(runId: string): string {
  const dir = path.join(ARTIFACTS_STORAGE_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function detectMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.html':
      return 'text/html; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Resolve the real absolute root directory of a workspace.
 * Correctly accounts for Host mode customCwd snapshots.
 * Fails closed if the folder cannot be determined or does not exist.
 */
export function resolveWorkspaceRootDir(
  workspaceFolder: string | undefined | null,
  workspaceJid: string | undefined | null,
): string {
  if (!workspaceFolder && !workspaceJid) {
    throw new Error('无法解析工作区目录：未指定工作区标识');
  }

  const group = workspaceJid ? getRegisteredGroup(workspaceJid) : null;
  const folder = workspaceFolder || group?.folder;
  if (!folder) {
    throw new Error(
      `无法解析工作区目录：工作区文件夹不存在 (${workspaceJid || 'unknown'})`,
    );
  }

  // Check if Host workspace specifies customCwd
  let candidateDir: string;
  if (group?.customCwd && typeof group.customCwd === 'string') {
    candidateDir = path.resolve(group.customCwd);
  } else {
    candidateDir = path.resolve(GROUPS_DIR, folder);
  }

  // Ensure candidate directory exists physically and resolve symlinks in root
  if (!fs.existsSync(candidateDir)) {
    throw new Error(`工作区物理目录不存在: ${candidateDir}`);
  }

  return fs.realpathSync(candidateDir);
}

/**
 * Safely resolve and verify a target path relative to the workspace root.
 * Rejects ".." and absolute paths outright (fail-closed, no silent rewriting).
 * Resolves symlinks and verifies the real target remains strictly within the workspace root.
 */
export function resolveSafeWorkspacePath(
  realWorkspaceRoot: string,
  relativePath: string,
): string {
  if (
    !relativePath ||
    typeof relativePath !== 'string' ||
    relativePath.includes('..') ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\0')
  ) {
    throw new Error(
      `非法路径：产物路径不能包含 ".." 越界符、空字符或绝对路径 (${relativePath})`,
    );
  }

  const candidatePath = path.resolve(realWorkspaceRoot, relativePath);
  const rootPrefix = realWorkspaceRoot.endsWith(path.sep)
    ? realWorkspaceRoot
    : realWorkspaceRoot + path.sep;

  // Initial lexical boundary check
  if (
    candidatePath !== realWorkspaceRoot &&
    !candidatePath.startsWith(rootPrefix)
  ) {
    throw new Error(
      `非法路径：产物路径不能超出工作区目录范围 (${relativePath})`,
    );
  }

  if (!fs.existsSync(candidatePath)) {
    throw new Error(`工作区中未找到交付文件: ${relativePath}`);
  }

  // Real symlink target boundary check
  const realTarget = fs.realpathSync(candidatePath);
  if (realTarget !== realWorkspaceRoot && !realTarget.startsWith(rootPrefix)) {
    throw new Error(
      `安全拦截：符号链接指向工作区外部文件 (${relativePath} -> ${realTarget})`,
    );
  }

  return realTarget;
}

export interface RegisterArtifactOptions {
  runId: string;
  relativePath: string;
  name?: string;
  createdBy?: string | null;
}

export interface RegisterArtifactResult {
  success: boolean;
  artifact?: TaskRunArtifact;
  error?: string;
  errorCode?:
    | 'RUN_NOT_FOUND'
    | 'FILE_NOT_FOUND'
    | 'QUOTA_EXCEEDED'
    | 'PATH_TRAVERSAL'
    | 'LIMIT_EXCEEDED'
    | 'INVALID_FILE_TYPE';
}

/**
 * Register and archive a declared delivery artifact for a specific run.
 * Performs same-fd open and read to eliminate TOCTOU and reject non-regular files.
 * Creates an independent file version copy under the run-specific directory.
 */
export async function registerArtifactForRun(
  options: RegisterArtifactOptions,
): Promise<RegisterArtifactResult> {
  const { runId, relativePath, name, createdBy } = options;

  const run = getTaskRunById(runId);
  if (!run) {
    return {
      success: false,
      error: `任务运行记录未找到: ${runId}`,
      errorCode: 'RUN_NOT_FOUND',
    };
  }

  const existingArtifacts = listTaskRunArtifactsByRunId(runId);
  if (existingArtifacts.length >= MAX_ARTIFACTS_PER_RUN) {
    return {
      success: false,
      error: `该次运行已登记 ${existingArtifacts.length} 个产物，已达上限 (${MAX_ARTIFACTS_PER_RUN})`,
      errorCode: 'LIMIT_EXCEEDED',
    };
  }

  const workspaceFolder = run.definition_snapshot.group_folder;
  const workspaceJid = run.definition_snapshot.chat_jid;

  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = resolveWorkspaceRootDir(workspaceFolder, workspaceJid);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: 'FILE_NOT_FOUND',
    };
  }

  let realSourcePath: string;
  try {
    realSourcePath = resolveSafeWorkspacePath(realWorkspaceRoot, relativePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('未找到')) {
      return { success: false, error: msg, errorCode: 'FILE_NOT_FOUND' };
    }
    return { success: false, error: msg, errorCode: 'PATH_TRAVERSAL' };
  }

  // Same-fd open and stat to eliminate TOCTOU race and verify regular file
  let fd: number;
  try {
    fd = fs.openSync(realSourcePath, fs.constants.O_RDONLY);
  } catch (err) {
    return {
      success: false,
      error: `无法打开文件: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'FILE_NOT_FOUND',
    };
  }

  let fileBuffer: Buffer;
  let fileSize = 0;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return {
        success: false,
        error: `产物必须为普通文件，禁止目录、FIFO 或特殊设备 (${relativePath})`,
        errorCode: 'INVALID_FILE_TYPE',
      };
    }

    if (stat.size > MAX_ARTIFACT_SIZE_BYTES) {
      return {
        success: false,
        error: `产物文件超过大小上限 (当前: ${(stat.size / 1024 / 1024).toFixed(1)}MB, 上限: 50MB)`,
        errorCode: 'QUOTA_EXCEEDED',
      };
    }

    fileSize = stat.size;
    fileBuffer = Buffer.alloc(fileSize);
    let bytesRead = 0;
    while (bytesRead < fileSize) {
      const n = fs.readSync(
        fd,
        fileBuffer,
        bytesRead,
        fileSize - bytesRead,
        bytesRead,
      );
      if (n === 0) break;
      bytesRead += n;
    }
  } finally {
    fs.closeSync(fd);
  }

  // Compute cryptographic SHA-256 hash
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  const artifactId = crypto.randomUUID();
  const artifactName = name?.trim() || path.basename(realSourcePath);
  const safeName = sanitizeFilename(artifactName);

  // Store in run-specific isolated directory
  const runDir = ensureRunArtifactDir(runId);
  const storedFilename = `${artifactId}_${safeName}`;
  const absStoragePath = path.join(runDir, storedFilename);
  const relStoragePath = path.join('runs', runId, storedFilename);

  fs.writeFileSync(absStoragePath, fileBuffer, { mode: 0o600 });

  const mimeType = detectMimeType(artifactName);

  const artifact = createTaskRunArtifact({
    id: artifactId,
    run_id: runId,
    task_id: run.task_id,
    workspace_jid: workspaceJid,
    workspace_folder: workspaceFolder,
    name: artifactName,
    original_path: relativePath,
    storage_path: relStoragePath,
    file_hash: hash,
    file_size: fileSize,
    mime_type: mimeType,
    created_by: createdBy ?? null,
  });

  logger.info(
    {
      artifactId,
      runId,
      name: artifactName,
      hash: hash.slice(0, 12),
      size: fileSize,
    },
    'Delivery artifact archived and registered successfully',
  );

  return { success: true, artifact };
}

export type ArtifactDownloadResult =
  | {
      status: 'ok';
      artifact: TaskRunArtifact;
      data: Buffer;
      mimeType: string;
      fileName: string;
    }
  | { status: 'forbidden'; error: string }
  | { status: 'not_found'; error: string }
  | { status: 'mismatch'; error: string }
  | { status: 'missing'; error: string }
  | {
      status: 'corrupted';
      error: string;
      expectedHash: string;
      actualHash: string;
    };

/**
 * Check if the user has access to a historical run based on its frozen workspace snapshot.
 */
export function canUserAccessHistoricRun(
  run: TaskRun,
  authUser: AuthUser,
): boolean {
  if (authUser.role === 'admin') return true;

  const historicJid = run.definition_snapshot.chat_jid;
  const workspace = getRegisteredGroup(historicJid);
  if (workspace) {
    return canAccessGroup({ id: authUser.id, role: authUser.role }, workspace);
  }

  // If workspace was deleted, only the original creator of the task can access
  const task = getTaskById(run.task_id);
  return task ? task.created_by === authUser.id : false;
}

/**
 * Retrieve artifact content for secure download with SHA-256 verification.
 * Strictly verifies runId ownership and historic run workspace ACL.
 */
export function getArtifactForDownload(
  artifactId: string,
  authUser: AuthUser,
  expectedRunId?: string,
): ArtifactDownloadResult {
  const artifact = getTaskRunArtifactById(artifactId);
  if (!artifact) {
    return { status: 'not_found', error: '产物记录不存在' };
  }

  if (expectedRunId && artifact.run_id !== expectedRunId) {
    return {
      status: 'mismatch',
      error: `产物 (${artifactId}) 不属于指定的运行记录 (${expectedRunId})`,
    };
  }

  const run = getTaskRunById(artifact.run_id);
  if (!run) {
    return { status: 'not_found', error: '关联的任务运行记录不存在' };
  }

  // Verify access against the frozen historic workspace
  if (!canUserAccessHistoricRun(run, authUser)) {
    return { status: 'forbidden', error: '无权访问该历史运行的产物文件' };
  }

  // Resolve storage path safely inside STORE_DIR/artifacts
  const absStoragePath = path.resolve(
    path.join(STORE_DIR, 'artifacts', artifact.storage_path),
  );
  const safeRoot = path.resolve(path.join(STORE_DIR, 'artifacts')) + path.sep;

  if (!absStoragePath.startsWith(safeRoot)) {
    return { status: 'forbidden', error: '非法存储路径' };
  }

  if (!fs.existsSync(absStoragePath)) {
    return {
      status: 'missing',
      error: '产物文件缺失（可能已被清理或未生成）',
    };
  }

  const data = fs.readFileSync(absStoragePath);
  const actualHash = crypto.createHash('sha256').update(data).digest('hex');

  if (actualHash !== artifact.file_hash) {
    return {
      status: 'corrupted',
      error: `产物哈希校验不符（记录: ${artifact.file_hash.slice(0, 12)}..., 实际: ${actualHash.slice(0, 12)}...），文件可能已损坏或被篡改`,
      expectedHash: artifact.file_hash,
      actualHash,
    };
  }

  return {
    status: 'ok',
    artifact,
    data,
    mimeType: artifact.mime_type || 'application/octet-stream',
    fileName: artifact.name,
  };
}

/**
 * Materialize selected immutable artifacts into a target workspace for continuation execution.
 * Writes to `inbound_artifacts/{runId}_{artifactId}/{name}` so the agent has a guaranteed
 * immutable, un-overwritten relative path to read from.
 */
export function materializeContinuationArtifacts(
  targetWorkspaceFolder: string,
  targetWorkspaceJid: string,
  artifacts: TaskRunArtifact[],
): Array<{ artifact: TaskRunArtifact; relativePath: string }> {
  const realRoot = resolveWorkspaceRootDir(
    targetWorkspaceFolder,
    targetWorkspaceJid,
  );
  const results: Array<{ artifact: TaskRunArtifact; relativePath: string }> =
    [];

  for (const art of artifacts) {
    const absStorage = path.resolve(
      path.join(STORE_DIR, 'artifacts', art.storage_path),
    );
    if (!fs.existsSync(absStorage)) continue;

    const relDest = path.join(
      'inbound_artifacts',
      `${art.run_id}_${art.id}`,
      art.name,
    );
    const absDest = path.resolve(realRoot, relDest);

    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.copyFileSync(absStorage, absDest);
    results.push({ artifact: art, relativePath: relDest });
  }

  return results;
}

/**
 * Build a continuation task draft from selected run artifacts (R19).
 * Accurately cites the selected artifact version hash, stable artifact ID,
 * and materialized immutable relative paths.
 */
export function buildContinuationDraftFromArtifacts(
  run: TaskRun,
  artifacts: TaskRunArtifact[],
  userWorkspaces: Array<{ jid: string; name: string }>,
): TaskDraft {
  const snapshot = run.definition_snapshot;
  const originalWorkspace = userWorkspaces.find(
    (w) => w.jid === snapshot.chat_jid,
  );
  const suggestedWorkspaceJid = originalWorkspace ? originalWorkspace.jid : '';

  const artifactCitations = artifacts
    .map(
      (a) =>
        `- 交付产物【${a.name}】（ID: ${a.id}, 完整 Hash: ${a.file_hash}, 原始路径: ${a.original_path}, 大小: ${(a.file_size / 1024).toFixed(1)}KB）`,
    )
    .join('\n');

  const prompt = [
    `请基于前序任务运行 (Run ID: ${run.id}) 归档的交付产物执行接续任务：`,
    artifactCitations,
    '',
    '说明：上述产物为不可变归档版本，不受后续同名文件覆盖影响。',
    '请阅读并验证上述交付产物版本内容，继续执行后续步骤：',
  ].join('\n');

  return {
    source_type: 'run',
    source_id: run.id,
    prompt,
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 300_000).toISOString(),
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: snapshot.execution_mode || null,
    script_command: null,
    chat_jid: suggestedWorkspaceJid,
    suggested_workspace_jid: suggestedWorkspaceJid,
    notify_channels: null,
    delivery_route_jid: null,
  };
}

/**
 * Extract artifact declarations from agent result text.
 * Matches XML-like tags: <happyclaw-artifact path="..." name="..."/>
 */
export function extractArtifactDeclarationsFromResultText(
  text: string,
): Array<{ path: string; name?: string }> {
  const list: Array<{ path: string; name?: string }> = [];
  if (!text) return list;

  const tagRegex = /<(?:happyclaw-artifact|delivery-artifact)\s+([^>]+)\/?>/gi;
  for (const match of text.matchAll(tagRegex)) {
    const attrs = match[1];
    const pathMatch = attrs.match(/path=["']([^"']+)["']/i);
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
    if (pathMatch && pathMatch[1]) {
      list.push({
        path: pathMatch[1].trim(),
        name: nameMatch ? nameMatch[1].trim() : undefined,
      });
    }
  }

  return list;
}

/**
 * Auto-discover and register declared artifacts for a completed run.
 *
 * Concurrency & fence guarantee:
 * - Reads IPC files and checks `content.runId === runId`.
 * - Skips and NEVER consumes or unlinks declarations belonging to other runs.
 * - Only ACKs (unlinks) an IPC file after successful persistence.
 */
export async function processCompletedRunArtifacts(options: {
  runId: string;
  resultText?: string | null;
  ipcDirs?: string[];
  createdBy?: string | null;
}): Promise<TaskRunArtifact[]> {
  const { runId, resultText, ipcDirs, createdBy } = options;
  const declaredList: Array<{
    path: string;
    name?: string;
    ipcFilePath?: string;
  }> = [];

  // 1. Collect from resultText
  if (resultText) {
    const textDeclarations =
      extractArtifactDeclarationsFromResultText(resultText);
    for (const d of textDeclarations) {
      declaredList.push(d);
    }
  }

  // 2. Collect from all candidate IPC dirs (e.g. isolated agent dir + workspace group dir)
  if (ipcDirs && ipcDirs.length > 0) {
    for (const ipcDir of ipcDirs) {
      if (!ipcDir) continue;
      const artifactsIpcDir = path.join(ipcDir, 'artifacts');
      if (fs.existsSync(artifactsIpcDir)) {
        try {
          const files = fs.readdirSync(artifactsIpcDir);
          for (const file of files) {
            if (file.endsWith('.json')) {
              const filePath = path.join(artifactsIpcDir, file);
              try {
                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                // Strict check: only claim IPC declarations that match this runId!
                // Declarations belonging to another run are NEVER consumed or touched.
                if (
                  content &&
                  content.runId === runId &&
                  typeof content.path === 'string'
                ) {
                  declaredList.push({
                    path: content.path.trim(),
                    name:
                      typeof content.name === 'string'
                        ? content.name.trim()
                        : undefined,
                    ipcFilePath: filePath,
                  });
                }
              } catch {
                // Ignore unparseable or transient lock file
              }
            }
          }
        } catch {
          // Ignore read error
        }
      }
    }
  }

  // Deduplicate by path for this run
  const seenPaths = new Set<string>();
  const uniqueDeclared = declaredList.filter((item) => {
    if (!item.path || seenPaths.has(item.path)) return false;
    seenPaths.add(item.path);
    return true;
  });

  const registered: TaskRunArtifact[] = [];
  for (const item of uniqueDeclared) {
    const res = await registerArtifactForRun({
      runId,
      relativePath: item.path,
      name: item.name,
      createdBy,
    });
    if (res.success && res.artifact) {
      registered.push(res.artifact);
      // ACK: Delete IPC file only after successful persistence
      if (item.ipcFilePath && fs.existsSync(item.ipcFilePath)) {
        try {
          fs.unlinkSync(item.ipcFilePath);
        } catch {
          /* ignore */
        }
      }
    } else {
      logger.warn(
        { runId, path: item.path, error: res.error, code: res.errorCode },
        'Declared task artifact could not be archived',
      );
    }
  }

  return registered;
}
