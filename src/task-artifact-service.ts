/**
 * Task Run Artifact Service (R19)
 *
 * Handles run-scoped artifact registration, physical file versioning,
 * SHA-256 tamper verification, quota enforcement, and continuation draft creation.
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
 * Safely resolve a path relative to the workspace directory.
 * Throws if the path escapes the workspace boundary.
 */
export function resolveSafeWorkspacePath(
  workspaceDir: string,
  relativePath: string,
): string {
  const normalizedRel = path
    .normalize(relativePath)
    .replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = path.resolve(workspaceDir, normalizedRel);
  const safeRoot = workspaceDir.endsWith(path.sep)
    ? workspaceDir
    : workspaceDir + path.sep;

  if (resolved !== workspaceDir && !resolved.startsWith(safeRoot)) {
    throw new Error(`非法路径：产物路径不能超出工作区范围 (${relativePath})`);
  }
  return resolved;
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
    | 'LIMIT_EXCEEDED';
}

/**
 * Register and archive a declared delivery artifact for a specific run.
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

  const workspaceFolder =
    run.definition_snapshot.group_folder ||
    (getRegisteredGroup(run.definition_snapshot.chat_jid)?.folder ?? '');
  const workspaceJid = run.definition_snapshot.chat_jid;
  const workspaceDir = path.join(GROUPS_DIR, workspaceFolder);

  let absSourcePath: string;
  try {
    absSourcePath = resolveSafeWorkspacePath(workspaceDir, relativePath);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: 'PATH_TRAVERSAL',
    };
  }

  if (!fs.existsSync(absSourcePath)) {
    const errorMsg = `工作区中未找到声明的交付文件: ${relativePath}`;
    logger.warn({ runId, relativePath, workspaceFolder }, errorMsg);
    return {
      success: false,
      error: errorMsg,
      errorCode: 'FILE_NOT_FOUND',
    };
  }

  const stat = fs.statSync(absSourcePath);
  if (stat.isDirectory()) {
    return {
      success: false,
      error: `产物不能是目录: ${relativePath}`,
      errorCode: 'FILE_NOT_FOUND',
    };
  }

  if (stat.size > MAX_ARTIFACT_SIZE_BYTES) {
    return {
      success: false,
      error: `产物文件超过大小上限 (当前: ${(stat.size / 1024 / 1024).toFixed(1)}MB, 上限: 50MB)`,
      errorCode: 'QUOTA_EXCEEDED',
    };
  }

  // Compute SHA-256 hash and read content
  const fileBuffer = fs.readFileSync(absSourcePath);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  const artifactId = crypto.randomUUID();
  const artifactName = name?.trim() || path.basename(absSourcePath);
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
    file_size: stat.size,
    mime_type: mimeType,
    created_by: createdBy ?? null,
  });

  logger.info(
    {
      artifactId,
      runId,
      name: artifactName,
      hash: hash.slice(0, 12),
      size: stat.size,
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
  | { status: 'missing'; error: string }
  | {
      status: 'corrupted';
      error: string;
      expectedHash: string;
      actualHash: string;
    };

/**
 * Retrieve artifact content for secure download with SHA-256 verification.
 */
export function getArtifactForDownload(
  artifactId: string,
  authUser: AuthUser,
): ArtifactDownloadResult {
  const artifact = getTaskRunArtifactById(artifactId);
  if (!artifact) {
    return { status: 'not_found', error: '产物记录不存在' };
  }

  // Permission check based on workspace ACL
  const workspace = getRegisteredGroup(artifact.workspace_jid);
  if (workspace) {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, workspace)) {
      return { status: 'forbidden', error: '无权访问该工作区的产物文件' };
    }
  } else {
    // If original workspace was removed/renamed, check if user created the task or is admin
    const task = getTaskById(artifact.task_id);
    const isOwner = task && task.created_by === authUser.id;
    if (authUser.role !== 'admin' && !isOwner) {
      return { status: 'forbidden', error: '无权访问此历史产物文件' };
    }
  }

  // Resolve storage path and prevent traversal
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
 * Build a continuation task draft from selected run artifacts (R19).
 * Accurately cites the selected artifact version hash and path.
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
        `- 交付产物【${a.name}】（版本 Hash: ${a.file_hash.slice(0, 12)}..., 路径: ${a.original_path}, 大小: ${(a.file_size / 1024).toFixed(1)}KB）`,
    )
    .join('\n');

  const prompt = [
    `请基于前序任务运行 (Run ID: ${run.id}) 的交付产物执行后续处理：`,
    artifactCitations,
    '',
    '请阅读并验证上述产物文件内容，继续执行后续步骤：',
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
 * Collects declarations from the IPC directory and result text.
 */
export async function processCompletedRunArtifacts(options: {
  runId: string;
  resultText?: string | null;
  ipcDir?: string;
  createdBy?: string | null;
}): Promise<TaskRunArtifact[]> {
  const { runId, resultText, ipcDir, createdBy } = options;
  const declaredList: Array<{ path: string; name?: string }> = [];

  // 1. Collect from resultText
  if (resultText) {
    declaredList.push(...extractArtifactDeclarationsFromResultText(resultText));
  }

  // 2. Collect from IPC dir if present
  if (ipcDir) {
    const artifactsIpcDir = path.join(ipcDir, 'artifacts');
    if (fs.existsSync(artifactsIpcDir)) {
      try {
        const files = fs.readdirSync(artifactsIpcDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = path.join(artifactsIpcDir, file);
            try {
              const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (content && typeof content.path === 'string') {
                declaredList.push({
                  path: content.path.trim(),
                  name:
                    typeof content.name === 'string'
                      ? content.name.trim()
                      : undefined,
                });
              }
              fs.unlinkSync(filePath); // Clean up consumed IPC file
            } catch {
              // ignore malformed file
            }
          }
        }
      } catch {
        // ignore read error
      }
    }
  }

  // Deduplicate by path
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
    } else {
      logger.warn(
        { runId, path: item.path, error: res.error, code: res.errorCode },
        'Declared task artifact could not be archived',
      );
    }
  }

  return registered;
}
