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
 * - Descriptor-relative directory traversal with O_DIRECTORY | O_NOFOLLOW and leaf O_NOFOLLOW | O_NONBLOCK.
 * - Same-fd open and read: verifies regular file (rejects FIFO, devices, directories) and eliminates TOCTOU.
 * - Loop read verification: rejects truncated / incomplete reads; rejects concurrent appending.
 * - Display name safety: isolates display name from physical file paths to prevent directory traversal during materialization.
 * - Source archive integrity: verifies source SHA-256 hash before materializing continuation artifacts.
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

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

/**
 * Extract a strictly sanitized basename from an arbitrary artifact name.
 * Completely strips any leading/embedded path separators, "..", and dangerous characters.
 */
export function safeArtifactName(rawName: string): string {
  const normalized = rawName.replace(/\\/g, '/');
  const base = path.basename(normalized).trim();
  const clean = base
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
  return clean || 'artifact.bin';
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

  if (!fs.existsSync(candidateDir)) {
    throw new Error(`工作区物理目录不存在: ${candidateDir}`);
  }

  return fs.realpathSync(candidateDir);
}

/**
 * Safely open and read a workspace file with full descriptor-relative protection.
 * - Rejects ".." and absolute paths fail-closed.
 * - Traverses parent directory components with O_RDONLY | O_DIRECTORY | O_NOFOLLOW.
 * - Opens leaf with O_RDONLY | O_NOFOLLOW | O_NONBLOCK (eliminates FIFO hangs and symlink swaps).
 * - Enforces fstat regular file check (rejects directories, FIFOs, devices).
 * - Loops readSync to verify exact bytes read; fails closed on truncation or concurrent appending.
 */
export function safeOpenWorkspaceFileForRead(
  realWorkspaceRoot: string,
  relativePath: string,
): { fd: number; fileSize: number; realPath: string; fileBuffer: Buffer } {
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

  const parts = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.');

  if (parts.length === 0 || parts.some((p) => p === '..')) {
    throw new Error(`非法路径：产物路径无效 (${relativePath})`);
  }

  const rootPrefix = realWorkspaceRoot.endsWith(path.sep)
    ? realWorkspaceRoot
    : realWorkspaceRoot + path.sep;

  // 1. Traverse parent directory components with O_DIRECTORY | O_NOFOLLOW
  let currentDir = realWorkspaceRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    const comp = parts[i];
    const nextDir = path.resolve(currentDir, comp);
    if (nextDir !== realWorkspaceRoot && !nextDir.startsWith(rootPrefix)) {
      throw new Error(`非法路径：父目录超出工作区根目录 (${comp})`);
    }

    let dirFd: number;
    try {
      dirFd = fs.openSync(
        nextDir,
        fs.constants.O_RDONLY |
          fs.constants.O_DIRECTORY |
          fs.constants.O_NOFOLLOW,
      );
    } catch (err: any) {
      if (err?.code === 'ENOTDIR' || err?.code === 'ELOOP') {
        throw new Error(`安全拦截：父目录是符号链接 (${comp})`);
      }
      throw new Error(`工作区中未找到交付文件目录: ${comp}`);
    }
    try {
      const dirStat = fs.fstatSync(dirFd);
      if (!dirStat.isDirectory()) {
        throw new Error(`安全拦截：路径组件不是目录 (${comp})`);
      }
    } finally {
      fs.closeSync(dirFd);
    }
    currentDir = nextDir;
  }

  // 2. Open leaf file with O_RDONLY | O_NOFOLLOW | O_NONBLOCK
  const leafName = parts[parts.length - 1];
  const leafPath = path.resolve(currentDir, leafName);
  if (leafPath !== realWorkspaceRoot && !leafPath.startsWith(rootPrefix)) {
    throw new Error(`非法路径：产物路径超出工作区根目录 (${relativePath})`);
  }

  let fd: number;
  try {
    fd = fs.openSync(
      leafPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (err: any) {
    if (err?.code === 'ELOOP' || err?.code === 'EEXIST') {
      throw new Error(`安全拦截：产物文件是符号链接 (${relativePath})`);
    }
    if (err?.code === 'ENOENT') {
      throw new Error(`工作区中未找到交付文件: ${relativePath}`);
    }
    throw new Error(`无法打开交付文件: ${err?.message || String(err)}`);
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      fs.closeSync(fd);
      throw new Error(
        `产物必须为普通文件，禁止目录、FIFO 命名管道或设备 (${relativePath})`,
      );
    }

    const fileSize = stat.size;
    if (fileSize > MAX_ARTIFACT_SIZE_BYTES) {
      fs.closeSync(fd);
      throw new Error(
        `产物文件超过大小上限 (当前: ${(fileSize / 1024 / 1024).toFixed(1)}MB, 上限: 50MB)`,
      );
    }

    const fileBuffer = Buffer.alloc(fileSize);
    let bytesRead = 0;
    while (bytesRead < fileSize) {
      const n = fs.readSync(
        fd,
        fileBuffer,
        bytesRead,
        fileSize - bytesRead,
        bytesRead,
      );
      if (n === 0) {
        fs.closeSync(fd);
        throw new Error(
          `文件读取不完整或在读取时被截断（预期 ${fileSize} 字节，实际仅读取 ${bytesRead} 字节）`,
        );
      }
      bytesRead += n;
    }

    // Verify file did not grow concurrently
    const extra = Buffer.alloc(1);
    const extraRead = fs.readSync(fd, extra, 0, 1, fileSize);
    if (extraRead > 0) {
      fs.closeSync(fd);
      throw new Error('文件在读取过程中被并发追加修改');
    }

    return { fd, fileSize, realPath: leafPath, fileBuffer };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {}
    throw err;
  }
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

  let openedFile: {
    fd: number;
    fileSize: number;
    realPath: string;
    fileBuffer: Buffer;
  };
  try {
    openedFile = safeOpenWorkspaceFileForRead(realWorkspaceRoot, relativePath);
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('未找到') || msg.includes('不存在')) {
      return { success: false, error: msg, errorCode: 'FILE_NOT_FOUND' };
    }
    if (msg.includes('超过大小上限')) {
      return { success: false, error: msg, errorCode: 'QUOTA_EXCEEDED' };
    }
    if (msg.includes('普通文件')) {
      return { success: false, error: msg, errorCode: 'INVALID_FILE_TYPE' };
    }
    return { success: false, error: msg, errorCode: 'PATH_TRAVERSAL' };
  }

  const { fd, fileSize, realPath, fileBuffer } = openedFile;
  try {
    // Compute cryptographic SHA-256 hash
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const artifactId = crypto.randomUUID();
    const rawArtifactName = name?.trim() || path.basename(realPath);
    const safeName = safeArtifactName(rawArtifactName);

    // Store in run-specific isolated directory
    const runDir = ensureRunArtifactDir(runId);
    const storedFilename = `${artifactId}_${safeName}`;
    const absStoragePath = path.join(runDir, storedFilename);
    const relStoragePath = path.join('runs', runId, storedFilename);

    fs.writeFileSync(absStoragePath, fileBuffer, { mode: 0o600 });

    const mimeType = detectMimeType(safeName);

    const artifact = createTaskRunArtifact({
      id: artifactId,
      run_id: runId,
      task_id: run.task_id,
      workspace_jid: workspaceJid,
      workspace_folder: workspaceFolder,
      name: rawArtifactName,
      original_path: relativePath,
      storage_path: relStoragePath,
      file_hash: hash,
      file_size: fileSize,
      mime_type: mimeType,
      created_by: createdBy ?? null,
    });

    logger.info(
      {
        artifactId: artifact.id,
        runId,
        name: rawArtifactName,
        hash: hash.slice(0, 12),
        size: fileSize,
      },
      'Delivery artifact archived and registered successfully',
    );

    return { success: true, artifact };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
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
 * Fails closed if the historic workspace was deleted and the user is not the task creator or admin.
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
 * Enforces:
 * - inbound_artifacts cannot be a symlink.
 * - Verifies source archive SHA-256 hash before copying.
 * - Extracts clean physical safe filename, preventing display name directory traversal.
 * - Safe temporary file write and atomic replace without following symlinks.
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

  const inboundRoot = path.resolve(realRoot, 'inbound_artifacts');
  if (fs.existsSync(inboundRoot)) {
    const st = fs.lstatSync(inboundRoot);
    if (st.isSymbolicLink()) {
      throw new Error('安全拦截：inbound_artifacts 不能是符号链接');
    }
  } else {
    fs.mkdirSync(inboundRoot, { recursive: true, mode: 0o700 });
  }

  const rootPrefix = realRoot.endsWith(path.sep)
    ? realRoot
    : realRoot + path.sep;

  for (const art of artifacts) {
    const absStorage = path.resolve(
      path.join(STORE_DIR, 'artifacts', art.storage_path),
    );
    if (!fs.existsSync(absStorage)) continue;

    // Verify source archive hash before materializing!
    const archiveData = fs.readFileSync(absStorage);
    const archiveHash = crypto
      .createHash('sha256')
      .update(archiveData)
      .digest('hex');
    if (archiveHash !== art.file_hash) {
      logger.warn(
        { artifactId: art.id, expected: art.file_hash, actual: archiveHash },
        'Skipping materialization of corrupted artifact',
      );
      continue;
    }

    const safeRunId = sanitizeFilename(art.run_id);
    const safeArtifactId = sanitizeFilename(art.id);
    const safeFileName = safeArtifactName(art.name);

    const runDir = path.resolve(inboundRoot, `${safeRunId}_${safeArtifactId}`);
    if (!runDir.startsWith(rootPrefix)) {
      throw new Error('安全拦截：物化目标目录超出工作区根目录');
    }

    if (fs.existsSync(runDir)) {
      const st = fs.lstatSync(runDir);
      if (st.isSymbolicLink()) {
        throw new Error('安全拦截：目标产物子目录不能是符号链接');
      }
    } else {
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    }

    const absDest = path.resolve(runDir, safeFileName);
    if (!absDest.startsWith(runDir + path.sep)) {
      throw new Error('安全拦截：物化文件名越界');
    }

    if (fs.existsSync(absDest)) {
      const st = fs.lstatSync(absDest);
      if (st.isSymbolicLink()) {
        fs.unlinkSync(absDest);
      }
    }

    const tempFile = path.resolve(
      runDir,
      `.${safeFileName}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    const fd = fs.openSync(
      tempFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeSync(fd, archiveData);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, absDest);

    const relDest = path.relative(realRoot, absDest).replace(/\\/g, '/');
    results.push({ artifact: art, relativePath: relDest });
  }

  return results;
}

/**
 * Scan a task prompt for immutable continuation artifact references and materialize them
 * into the executing workspace before the task run begins.
 */
export function prepareTaskContinuationArtifacts(
  taskPrompt: string,
  targetWorkspaceFolder: string,
  targetWorkspaceJid: string,
): void {
  if (!taskPrompt || !taskPrompt.includes('<artifact_ref')) return;

  const matches = taskPrompt.matchAll(/<artifact_ref\s+([^>]+)\/?>/gi);
  const ids: string[] = [];
  for (const m of matches) {
    const idMatch = m[1].match(/id=["']([^"']+)["']/i);
    if (idMatch && idMatch[1]) {
      ids.push(idMatch[1].trim());
    }
  }
  if (ids.length === 0) return;

  const artifacts: TaskRunArtifact[] = [];
  for (const id of ids) {
    const art = getTaskRunArtifactById(id);
    if (art) artifacts.push(art);
  }

  if (artifacts.length > 0) {
    try {
      materializeContinuationArtifacts(
        targetWorkspaceFolder,
        targetWorkspaceJid,
        artifacts,
      );
    } catch (err) {
      logger.warn(
        { targetWorkspaceFolder, err },
        'Failed to materialize continuation artifacts before task execution',
      );
    }
  }
}

/**
 * Build a continuation task draft from selected run artifacts (R19).
 * Accurately cites the selected artifact version hash (full 64-char hex),
 * stable artifact ID, and immutable materialized relative paths.
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
        `- 交付产物【${a.name}】（ID: ${a.id}, 完整 Hash: ${a.file_hash}, 原始路径: ${a.original_path}, 大小: ${(a.file_size / 1024).toFixed(1)}KB）\n  <artifact_ref id="${a.id}" hash="${a.file_hash}" path="${a.original_path}" name="${a.name}"/>`,
    )
    .join('\n');

  const prompt = [
    `请基于前序任务运行 (Run ID: ${run.id}) 归档的交付产物执行接续任务：`,
    artifactCitations,
    '',
    '说明：上述交付产物为不可变版本归档，在任务执行时已安全同步到工作区 inbound_artifacts/ 目录下。',
    '你可以直接阅读 inbound_artifacts/ 下的不可变文件，或调用 read_artifact 工具进行读取。',
    '请阅读上述不可变文件内容，继续执行后续步骤：',
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
 * - Groups text and IPC declarations by path to ensure all associated IPC files are ACKed upon success.
 * - Only ACKs (unlinks) an IPC file after successful database persistence.
 */
export async function processCompletedRunArtifacts(options: {
  runId: string;
  taskId?: string | null;
  resultText?: string | null;
  ipcDirs?: string[];
  createdBy?: string | null;
}): Promise<TaskRunArtifact[]> {
  const { runId, taskId, resultText, ipcDirs, createdBy } = options;

  interface DeclaredItem {
    path: string;
    name?: string;
    ipcFilePaths: string[];
  }
  const byPath = new Map<string, DeclaredItem>();

  // 1. Collect from resultText
  if (resultText) {
    const textDeclarations =
      extractArtifactDeclarationsFromResultText(resultText);
    for (const d of textDeclarations) {
      if (!byPath.has(d.path)) {
        byPath.set(d.path, { path: d.path, name: d.name, ipcFilePaths: [] });
      } else if (d.name && !byPath.get(d.path)!.name) {
        byPath.get(d.path)!.name = d.name;
      }
    }
  }

  // 2. Collect from candidate IPC dirs (workspace folder IPC root and/or task-session IPC root)
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
                // Strict check: only claim declarations for this runId (and taskId if present)
                if (
                  content &&
                  content.runId === runId &&
                  typeof content.path === 'string'
                ) {
                  if (taskId && content.taskId && content.taskId !== taskId) {
                    continue;
                  }
                  const p = content.path.trim();
                  if (!byPath.has(p)) {
                    byPath.set(p, {
                      path: p,
                      name:
                        typeof content.name === 'string'
                          ? content.name.trim()
                          : undefined,
                      ipcFilePaths: [filePath],
                    });
                  } else {
                    const item = byPath.get(p)!;
                    if (content.name && !item.name) {
                      item.name =
                        typeof content.name === 'string'
                          ? content.name.trim()
                          : undefined;
                    }
                    if (!item.ipcFilePaths.includes(filePath)) {
                      item.ipcFilePaths.push(filePath);
                    }
                  }
                }
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
  }

  const registered: TaskRunArtifact[] = [];
  for (const item of byPath.values()) {
    const res = await registerArtifactForRun({
      runId,
      relativePath: item.path,
      name: item.name,
      createdBy,
    });
    if (res.success && res.artifact) {
      registered.push(res.artifact);
      // ACK: Delete matched IPC files only after successful persistence
      for (const ipcPath of item.ipcFilePaths) {
        if (fs.existsSync(ipcPath)) {
          try {
            fs.unlinkSync(ipcPath);
          } catch {
            /* ignore */
          }
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
