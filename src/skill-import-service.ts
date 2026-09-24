import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { validateSkillId } from './skill-utils.js';
import {
  assertResolvesToPublicAddress,
  validateSafeHttpsUrl,
} from './url-safety.js';
import { SKILL_ARCHIVE_MAX_FILE_BYTES } from './http-upload-policy.js';
import {
  buildPinnedGitEnvironment,
  startPinnedHttpsProxy,
} from './safe-git-proxy.js';

const execFileAsync = promisify(execFile);
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_SCAN_DEPTH = 5;
export const MAX_GIT_REPOSITORY_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface SkillImportResult {
  installed: string[];
  sourceUrl?: string;
  version?: string;
}

interface DirectoryQuotaCommandOptions {
  command: string;
  args: string[];
  watchDir: string;
  maxBytes: number;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  label?: string;
}

function directorySizeUntil(root: string, maxBytes: number): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
      continue;
    }
    if (stat.isFile()) {
      total += stat.size;
      if (total > maxBytes) return total;
    }
  }
  return total;
}

export function runCommandWithDirectoryQuota(
  options: DirectoryQuotaCommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const label = options.label ?? 'Command';
    const child = spawn(options.command, options.args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let quotaExceeded = false;
    let timedOut = false;
    let monitorError: Error | undefined;
    let settled = false;

    const appendOutput = (chunk: Buffer): void => {
      if (output.length >= MAX_COMMAND_OUTPUT_BYTES) return;
      output += chunk
        .toString()
        .slice(0, MAX_COMMAND_OUTPUT_BYTES - output.length);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const stopProcessGroup = (): void => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const monitor = setInterval(() => {
      try {
        if (
          directorySizeUntil(options.watchDir, options.maxBytes) >
          options.maxBytes
        ) {
          quotaExceeded = true;
          stopProcessGroup();
        }
      } catch (error) {
        monitorError =
          error instanceof Error ? error : new Error(String(error));
        stopProcessGroup();
      }
    }, options.pollIntervalMs ?? 50);
    monitor.unref();

    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessGroup();
    }, options.timeoutMs);
    timeout.unref();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      try {
        if (
          directorySizeUntil(options.watchDir, options.maxBytes) >
          options.maxBytes
        ) {
          quotaExceeded = true;
        }
      } catch (error) {
        monitorError =
          error instanceof Error ? error : new Error(String(error));
      }
      if (quotaExceeded) {
        finish(
          new Error(
            `${label} exceeds the ${Math.floor(options.maxBytes / 1024 / 1024)} MB size limit`,
          ),
        );
      } else if (timedOut) {
        finish(new Error(`${label} timed out`));
      } else if (monitorError) {
        finish(monitorError);
      } else if (code !== 0) {
        const details = output.trim();
        finish(
          new Error(
            `${label} failed${signal ? ` (${signal})` : ''}${details ? `: ${details}` : ''}`,
          ),
        );
      } else {
        finish();
      }
    });
  });
}

function isSymlinkMode(attributes: number): boolean {
  const unixMode = (attributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function validateArchiveEntryName(entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error('Archive contains an unsafe absolute path');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Archive contains a path traversal entry');
  }
  return normalized;
}

function assertSafeSkillTree(root: string): void {
  let entries = 0;
  let totalBytes = 0;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ENTRIES)
        throw new Error('Skill contains too many files');
      const fullPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Skill packages cannot contain symbolic links');
      }
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_EXPANDED_BYTES) {
          throw new Error('Skill package is too large after extraction');
        }
      }
    }
  };
  visit(root);
}

function findSkillDirectories(
  root: string,
): Array<{ id: string; dir: string }> {
  const found = new Map<string, string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    const skillFile = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
      const id = path.basename(dir);
      if (!validateSkillId(id)) {
        throw new Error(`Invalid skill directory name: ${id}`);
      }
      if (found.has(id)) throw new Error(`Duplicate skill ID: ${id}`);
      found.set(id, dir);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === '.git' ||
        entry.name === 'node_modules'
      )
        continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  if (found.size === 0)
    throw new Error('No directory containing SKILL.md was found');
  return [...found]
    .map(([id, dir]) => ({ id, dir }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function installSkillDirectoriesTransactionally(
  candidates: Array<{ id: string; dir: string }>,
  targetRoot: string,
  replace: boolean,
  commit?: (installed: string[]) => void,
): string[] {
  fs.mkdirSync(targetRoot, { recursive: true });
  const conflicts = candidates.filter(({ id }) =>
    fs.existsSync(path.join(targetRoot, id)),
  );
  if (conflicts.length > 0 && !replace) {
    throw new Error(
      `Skill already exists: ${conflicts.map(({ id }) => id).join(', ')}`,
    );
  }

  const transactionDir = fs.mkdtempSync(path.join(targetRoot, '.import-'));
  const backups: Array<{ destination: string; backup: string }> = [];
  const installed: string[] = [];
  try {
    for (const candidate of candidates) {
      const staged = path.join(transactionDir, candidate.id);
      fs.cpSync(candidate.dir, staged, { recursive: true, dereference: false });
      assertSafeSkillTree(staged);
    }
    for (const candidate of candidates) {
      const destination = path.join(targetRoot, candidate.id);
      if (fs.existsSync(destination)) {
        const backup = path.join(transactionDir, `.backup-${candidate.id}`);
        fs.renameSync(destination, backup);
        backups.push({ destination, backup });
      }
      fs.renameSync(path.join(transactionDir, candidate.id), destination);
      installed.push(candidate.id);
    }
    commit?.([...installed]);
    for (const { backup } of backups)
      fs.rmSync(backup, { recursive: true, force: true });
    return installed;
  } catch (error) {
    for (const id of installed)
      fs.rmSync(path.join(targetRoot, id), { recursive: true, force: true });
    for (const { destination, backup } of backups) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    }
    throw error;
  } finally {
    fs.rmSync(transactionDir, { recursive: true, force: true });
  }
}

export async function importSkillsFromGit(options: {
  url: string;
  ref?: string;
  subdirectory?: string;
  targetRoot: string;
  replace?: boolean;
  commit?: (result: SkillImportResult) => void;
}): Promise<SkillImportResult> {
  const reason = validateSafeHttpsUrl(options.url);
  if (reason) throw new Error(`Refused Git URL: ${reason}`);
  const parsedUrl = new URL(options.url);
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Git URLs containing credentials are not allowed');
  }
  await assertResolvesToPublicAddress(parsedUrl.hostname, 'Git hostname');
  if (options.ref && !/^[\w./-]{1,200}$/.test(options.ref)) {
    throw new Error('Invalid Git ref');
  }
  if (options.subdirectory) {
    const normalized = path.posix.normalize(
      options.subdirectory.replace(/\\/g, '/'),
    );
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error('Invalid Git subdirectory');
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-git-import-'));
  const repoDir = path.join(tempDir, 'repo');
  try {
    const gitProxy = await startPinnedHttpsProxy(parsedUrl.hostname, {
      expectedPort: parsedUrl.port ? Number(parsedUrl.port) : 443,
    });
    const args = [
      '-c',
      `http.proxy=${gitProxy.url}`,
      '-c',
      'http.followRedirects=false',
      '-c',
      'protocol.file.allow=never',
      '-c',
      'submodule.recurse=false',
      'clone',
      '--depth',
      '1',
      '--no-tags',
      '--single-branch',
    ];
    if (options.ref) args.push('--branch', options.ref);
    args.push('--', options.url, repoDir);
    try {
      await runCommandWithDirectoryQuota({
        command: 'git',
        args,
        watchDir: tempDir,
        maxBytes: MAX_GIT_REPOSITORY_BYTES,
        timeoutMs: 60_000,
        label: 'Git repository',
        env: buildPinnedGitEnvironment(gitProxy.url),
      });
    } finally {
      await gitProxy.close();
    }
    const scanRoot = options.subdirectory
      ? path.resolve(repoDir, options.subdirectory)
      : repoDir;
    if (scanRoot !== repoDir && !scanRoot.startsWith(`${repoDir}${path.sep}`)) {
      throw new Error('Git subdirectory escapes the repository');
    }
    if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
      throw new Error('Git subdirectory does not exist');
    }
    const candidates = findSkillDirectories(scanRoot);
    for (const candidate of candidates) assertSafeSkillTree(candidate.dir);
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoDir,
      'rev-parse',
      'HEAD',
    ]);
    const version = stdout.trim();
    const installed = installSkillDirectoriesTransactionally(
      candidates,
      options.targetRoot,
      options.replace === true,
      (installedIds) =>
        options.commit?.({
          installed: installedIds,
          sourceUrl: options.url,
          version,
        }),
    );
    return { installed, sourceUrl: options.url, version };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Shared SSRF gate for skill *URL* installs (POST /api/skills/install and
 * workspace-config skills/install). Literal validateSafeHttpsUrl alone cannot
 * stop DNS rebinding or redirect-to-private; callers must not shell a
 * redirect-following fetcher (npx skills add) after that check.
 *
 * URL installs are restricted to GitHub HTTPS repos and routed through
 * importSkillsFromGit (resolve + pinned CONNECT proxy + followRedirects=false).
 * npm `<scope>/<name>` package form is unchanged and does not use this helper.
 */
export async function assertSafeSkillInstallUrl(raw: string): Promise<URL> {
  const reason = validateSafeHttpsUrl(raw);
  if (reason) throw new Error(`Refused skill URL: ${reason}`);
  const parsed = new URL(raw);
  if (parsed.username || parsed.password) {
    throw new Error('Skill URLs containing credentials are not allowed');
  }
  await assertResolvesToPublicAddress(parsed.hostname, 'Skill hostname');
  return parsed;
}

export interface SkillUrlGitInstallTarget {
  url: string;
  ref?: string;
  subdirectory?: string;
}

function normalizeSkillGitHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

export function isAllowedSkillUrlGitHost(hostname: string): boolean {
  const host = normalizeSkillGitHostname(hostname);
  return host === 'github.com' || host === 'www.github.com';
}

/**
 * Validate + resolve a skill install URL, then map allowlisted GitHub HTTPS
 * URLs onto importSkillsFromGit options. Non-GitHub HTTPS URLs that would
 * previously have been handed to `npx skills add` (redirect-following) are
 * refused here.
 */
export async function resolveSkillUrlGitInstall(
  raw: string,
): Promise<SkillUrlGitInstallTarget> {
  const parsed = await assertSafeSkillInstallUrl(raw);
  if (!isAllowedSkillUrlGitHost(parsed.hostname)) {
    throw new Error(
      'Skill URL installs are limited to GitHub HTTPS repositories; use npm package form or POST /api/skills/import/git for other hosts',
    );
  }
  const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('Skill GitHub URL must include owner and repository');
  }
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new Error('Invalid GitHub owner or repository name');
  }
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  if (parts.length === 2) {
    return { url: repoUrl };
  }
  if (parts[2] === 'tree' && parts.length >= 4) {
    const ref = parts[3];
    if (!/^[\w./-]{1,200}$/.test(ref)) {
      throw new Error('Invalid Git ref in skill URL');
    }
    const subdirectory =
      parts.length > 4 ? parts.slice(4).join('/') : undefined;
    return { url: repoUrl, ref, subdirectory };
  }
  if (parts[2] === 'blob') {
    throw new Error(
      'GitHub blob URLs are not supported for skill install; use a repository or tree URL',
    );
  }
  throw new Error(
    'Unsupported GitHub skill URL path; use a repository or tree URL',
  );
}

/** Install a skill URL via the pinned Git importer (no npx / no redirect follow). */
export async function installSkillUrlViaPinnedGit(options: {
  packageUrl: string;
  targetRoot: string;
  replace?: boolean;
  commit?: (result: SkillImportResult) => void;
}): Promise<SkillImportResult> {
  const target = await resolveSkillUrlGitInstall(options.packageUrl);
  return importSkillsFromGit({
    url: target.url,
    ref: target.ref,
    subdirectory: target.subdirectory,
    targetRoot: options.targetRoot,
    replace: options.replace,
    commit: options.commit,
  });
}

export function importSkillsFromZip(options: {
  archive: Buffer;
  archiveName: string;
  targetRoot: string;
  replace?: boolean;
  commit?: (result: SkillImportResult) => void;
}): SkillImportResult {
  if (
    options.archive.byteLength === 0 ||
    options.archive.byteLength > SKILL_ARCHIVE_MAX_FILE_BYTES
  ) {
    throw new Error('ZIP archive must be between 1 byte and 10 MB');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-zip-import-'));
  try {
    const zip = new AdmZip(options.archive);
    const entries = zip.getEntries();
    if (entries.length === 0 || entries.length > MAX_ENTRIES) {
      throw new Error('ZIP archive has an invalid number of entries');
    }
    let expandedBytes = 0;
    for (const entry of entries) {
      validateArchiveEntryName(entry.entryName);
      if (isSymlinkMode(entry.attr))
        throw new Error('ZIP archives cannot contain symbolic links');
      expandedBytes += entry.header.size;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('ZIP archive is too large after extraction');
      }
    }
    zip.extractAllTo(tempDir, true, false);
    assertSafeSkillTree(tempDir);
    const candidates = findSkillDirectories(tempDir);
    const installed = installSkillDirectoriesTransactionally(
      candidates,
      options.targetRoot,
      options.replace === true,
      (installedIds) =>
        options.commit?.({
          installed: installedIds,
          sourceUrl: options.archiveName,
        }),
    );
    return { installed, sourceUrl: options.archiveName };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
