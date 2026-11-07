#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

import {
  isStaleMountEntryError,
  readDescriptorMountId,
} from './session-permissions-mount.mjs';
import { createBoundedRescanScheduler } from './session-permissions-rescan-queue.mjs';

const READY_FILE = '/run/happyclaw-session-watcher.ready';
const FAILED_FILE = '/run/happyclaw-session-watcher.failed';
const RESCAN_INTERVAL_MS = 30_000;
const MAX_RECOVERY_FAILURES = 3;
const OPEN_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
const ROOT_OPEN_FLAGS = OPEN_FLAGS | fs.constants.O_DIRECTORY;

const passwdEntry = fs
  .readFileSync('/etc/passwd', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('node:'));
if (!passwdEntry) throw new Error('node passwd entry is missing');
const nodeUid = Number(passwdEntry.split(':')[2]);
const nodeGid = Number(passwdEntry.split(':')[3]);
if (
  !Number.isSafeInteger(nodeUid) ||
  nodeUid <= 0 ||
  !Number.isSafeInteger(nodeGid) ||
  nodeGid <= 0
) {
  throw new Error('node uid or primary gid is invalid');
}
const directMigration = process.argv.includes('--migrate-direct');
const directMountRoots = process.argv.includes(
  '--normalize-direct-mount-roots',
);
const nodeOwnedMounts = process.argv.includes('--normalize-node-owned-mounts');
const nodeOwnedWatch = process.argv.includes('--watch-node-owned-mounts');
const generatedOption = process.argv.find((argument) =>
  argument.startsWith('--normalize-generated='),
);
const generatedKey = generatedOption?.slice('--normalize-generated='.length);
const oneShotOperationCount = [
  directMigration,
  directMountRoots,
  nodeOwnedMounts,
  generatedKey !== undefined,
].filter(Boolean).length;
if (oneShotOperationCount > 1) {
  throw new Error(
    'multiple permission normalization operations were requested',
  );
}
if (nodeOwnedWatch && oneShotOperationCount > 0) {
  throw new Error('live and one-shot permission operations cannot be combined');
}

// These are the only writable bind roots the root watcher may touch. Session,
// CLI state and IPC use fixed data modes. Workspace and durable extra files
// mirror their owner's rwx bits to the node group so executable intent survives.
const mountedRoots = [
  {
    path: '/home/node/.claude',
    policy: 'managed',
    directMigration: true,
  },
  {
    path: '/home/node/.feishu-cli',
    policy: 'managed',
    optional: true,
    directMigration: true,
  },
  { path: '/workspace/ipc', policy: 'managed' },
  { path: '/workspace/group', policy: 'mirror' },
  { path: '/workspace/extra', policy: 'mirror' },
];

const generatedRoots = new Map([
  [
    'npm-global',
    {
      path: '/workspace/extra/.npm-global',
      policy: 'mirror',
      normalization: 'node-owned',
    },
  ],
  [
    'skills',
    {
      path: '/home/node/.claude/skills',
      policy: 'managed',
      normalization: 'node-owned',
    },
  ],
  [
    'dist',
    {
      path: '/tmp/dist',
      policy: 'managed',
      normalization: 'node-readonly',
    },
  ],
  [
    'chromium',
    {
      path: '/tmp/happyclaw-chromium-profile',
      policy: 'managed',
      normalization: 'node-owned',
    },
  ],
]);

let roots;
if (generatedKey !== undefined) {
  const generatedRoot = generatedRoots.get(generatedKey);
  if (!generatedRoot) {
    throw new Error(`unknown generated permission root: ${generatedKey}`);
  }
  roots = [{ ...generatedRoot }];
} else {
  roots = mountedRoots.map((root) => ({
    ...root,
    normalization: directMigration
      ? 'direct-migration'
      : directMountRoots || nodeOwnedMounts || nodeOwnedWatch
        ? 'node-owned'
        : 'shared',
    rootOnly: directMountRoots,
  }));
}

const watchers = new Map();
const rescanSchedulers = new Map();
const reportedStaleEntries = new Set();
const recoveryFailures = new Map();
let stopping = false;
let periodicTimer;

function isReadonlyError(error) {
  return error && (error.code === 'EROFS' || error.code === 'ENOTSUP');
}

function isVanishedOrSymlink(error) {
  return (
    error &&
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      error.code === 'ELOOP' ||
      error.code === 'ENXIO')
  );
}

function relativeComponents(relativeName) {
  if (!Buffer.isBuffer(relativeName) || relativeName.length === 0) return null;
  if (relativeName[0] === 0x2f || relativeName.includes(0)) return null;

  const components = [];
  let start = 0;
  for (let index = 0; index <= relativeName.length; index += 1) {
    if (index !== relativeName.length && relativeName[index] !== 0x2f) continue;
    const component = relativeName.subarray(start, index);
    if (
      component.length === 0 ||
      (component.length === 1 && component[0] === 0x2e) ||
      (component.length === 2 && component[0] === 0x2e && component[1] === 0x2e)
    ) {
      return null;
    }
    components.push(Buffer.from(component));
    start = index + 1;
  }
  return components;
}

function procFdPath(fd) {
  return `/proc/self/fd/${fd}`;
}

function procFdChildPath(parentFd, component) {
  return Buffer.concat([Buffer.from(`${procFdPath(parentFd)}/`), component]);
}

function openChild(parentFd, component) {
  try {
    // /proc/self/fd/<parent>/<name> gives Node an openat-like operation. The
    // parent descriptor is already beneath a fixed root and O_NOFOLLOW applies
    // to the untrusted final component.
    return fs.openSync(procFdChildPath(parentFd, component), OPEN_FLAGS);
  } catch (error) {
    if (isVanishedOrSymlink(error)) return null;
    if (isStaleMountEntryError(error, parentFd)) {
      reportStaleEntry(parentFd, component, error);
      return null;
    }
    throw error;
  }
}

function reportStaleEntry(parentFd, component, error) {
  // Periodic scans meet the same stale entry every 30 seconds; say it once per
  // path. The parent path names the mount for operators; it is best effort.
  let parentPath = '';
  try {
    parentPath = fs.readlinkSync(procFdPath(parentFd));
  } catch {
    parentPath = '';
  }
  const name = component.toString();
  const key = `${parentPath}\0${component.toString('hex')}`;
  if (reportedStaleEntries.has(key)) return;
  reportedStaleEntries.add(key);
  const shown = parentPath ? `${parentPath}/${name}` : name;
  process.stderr.write(
    `happyclaw: skipping stale mount entry ${JSON.stringify(shown)} (${
      error.code
    })\n`,
  );
}

function mirrorMode(stat, directory) {
  let ownerBits = (stat.mode >>> 6) & 0o7;
  if (ownerBits === 0) ownerBits = directory ? 0o7 : 0o6;
  const shared = (ownerBits << 6) | (ownerBits << 3);
  return directory ? 0o2000 | shared : shared;
}

function secureMode(stat, root) {
  if (root.normalization === 'direct-migration') {
    if (stat.isDirectory()) return 0o700;
    if (stat.isFile() || stat.isFIFO()) {
      return (stat.mode & 0o111) === 0 ? 0o600 : 0o700;
    }
    return null;
  }
  if (root.normalization === 'node-owned') {
    if (stat.isDirectory()) return 0o700;
    if (stat.isFile() || stat.isFIFO()) return stat.mode & 0o700;
    return null;
  }
  if (root.normalization === 'node-readonly') {
    if (stat.isDirectory()) return 0o500;
    if (stat.isFile()) return stat.mode & 0o500;
    return null;
  }
  if (stat.isDirectory()) {
    return root.policy === 'managed' ? 0o2770 : mirrorMode(stat, true);
  }
  if (stat.isFile() || stat.isFIFO()) {
    return root.policy === 'managed' ? 0o660 : mirrorMode(stat, false);
  }
  return null;
}

function inspectDescriptorBoundary(fd, root) {
  const stat = fs.fstatSync(fd);
  const mountId = readDescriptorMountId(fd);
  return {
    stat,
    outsideRootMount: stat.dev !== root.device || mountId !== root.mountId,
  };
}

function normalizeDescriptor(fd, root, required = false) {
  const { stat, outsideRootMount } = inspectDescriptorBoundary(fd, root);
  if (outsideRootMount) return { stat, outsideRootMount: true };
  const mode = secureMode(stat, root);
  if (mode === null) return { stat, outsideRootMount: false };

  let desiredUid;
  let desiredGid;
  if (root.normalization === 'direct-migration' && stat.uid !== 1000) {
    desiredUid = stat.uid;
    desiredGid = stat.gid;
  } else if (root.normalization === 'shared') {
    desiredUid = 0;
    desiredGid = nodeGid;
  } else {
    desiredUid = nodeUid;
    desiredGid = nodeGid;
  }
  const ownershipChanged = stat.uid !== desiredUid || stat.gid !== desiredGid;
  const modeChanged = (stat.mode & 0o7777) !== mode;
  if (
    !stat.isDirectory() &&
    stat.nlink > 1 &&
    (ownershipChanged || modeChanged)
  ) {
    const description =
      `multiply-linked inode ${stat.ino} under ${root.path} requires ` +
      'an ownership or mode change';
    if (
      root.policy === 'managed' ||
      root.normalization === 'direct-migration'
    ) {
      throw new Error(`refusing ${description}`);
    }
    process.stderr.write(`happyclaw: skipping ${description}\n`);
    return { stat, outsideRootMount: false };
  }
  try {
    // Every mutation is descriptor-based. An Agent may rename or replace the
    // directory entry, but it cannot redirect fchown/fchmod outside this fd.
    if (ownershipChanged) fs.fchownSync(fd, desiredUid, desiredGid);
    if (ownershipChanged || modeChanged) fs.fchmodSync(fd, mode);
  } catch (error) {
    if (!isReadonlyError(error) || required) throw error;
  }
  return { stat, outsideRootMount: false };
}

function openDirectory(fd) {
  // opendir follows only this trusted procfs magic-link to the already-open
  // directory. Reading one bounded batch at a time avoids retaining every
  // entry in a wide persistent directory during periodic and final scans.
  return fs.opendirSync(procFdPath(fd), {
    encoding: 'buffer',
    bufferSize: 32,
  });
}

function closeFrame(frame) {
  if (frame.directory !== undefined) {
    try {
      frame.directory.closeSync();
    } catch {}
    frame.directory = undefined;
  }
  if (frame.closeWhenDone) {
    try {
      fs.closeSync(frame.fd);
    } catch {}
  }
}

function normalizeTreeFromDescriptor(
  root,
  startFd,
  closeStart,
  required = false,
) {
  const stack = [
    {
      fd: startFd,
      closeWhenDone: closeStart,
      entered: false,
      directory: undefined,
      required,
    },
  ];

  try {
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        const result = normalizeDescriptor(frame.fd, root, frame.required);
        frame.entered = true;
        if (!result.stat.isDirectory() || result.outsideRootMount) {
          closeFrame(frame);
          stack.pop();
          continue;
        }
        try {
          frame.directory = openDirectory(frame.fd);
        } catch (error) {
          if (!isReadonlyError(error) || frame.required) throw error;
          closeFrame(frame);
          stack.pop();
          continue;
        }
      }

      const entry = frame.directory.readSync();
      if (entry === null) {
        closeFrame(frame);
        stack.pop();
        continue;
      }

      const childFd = openChild(frame.fd, entry.name);
      if (childFd === null) continue;
      stack.push({
        fd: childFd,
        closeWhenDone: true,
        entered: false,
        directory: undefined,
        required: false,
      });
    }
  } finally {
    for (const frame of stack) closeFrame(frame);
  }
}

function initializeRoots() {
  for (const root of roots) {
    if (directMigration && !root.directMigration) {
      root.active = false;
      continue;
    }
    try {
      root.fd = fs.openSync(root.path, ROOT_OPEN_FLAGS);
      const stat = fs.fstatSync(root.fd);
      if (!stat.isDirectory())
        throw new Error(`${root.path} is not a directory`);
      root.device = stat.dev;
      root.mountId = readDescriptorMountId(root.fd);
      root.active = true;
    } catch (error) {
      if (root.optional && error?.code === 'ENOENT') {
        root.active = false;
        continue;
      }
      throw error;
    }
  }
}

function closeRoots() {
  for (const root of roots) {
    if (!root.active || root.fd === undefined) continue;
    try {
      fs.closeSync(root.fd);
    } catch {}
    root.fd = undefined;
    root.active = false;
  }
}

function normalizeRoot(root) {
  if (!root.active) return;
  if (root.rootOnly) {
    normalizeDescriptor(root.fd, root, true);
  } else {
    normalizeTreeFromDescriptor(root, root.fd, false, true);
  }
}

function normalizeAll() {
  for (const root of roots) normalizeRoot(root);
}

function openEventTarget(root, components) {
  let parentFd = root.fd;
  let parentOwned = false;
  try {
    for (const component of components) {
      const childFd = openChild(parentFd, component);
      if (parentOwned) fs.closeSync(parentFd);
      parentOwned = false;
      if (childFd === null) return null;
      const { outsideRootMount } = inspectDescriptorBoundary(childFd, root);
      if (outsideRootMount) {
        fs.closeSync(childFd);
        return null;
      }
      parentFd = childFd;
      parentOwned = true;
    }
    return parentOwned ? parentFd : null;
  } catch (error) {
    if (parentOwned) {
      try {
        fs.closeSync(parentFd);
      } catch {}
    }
    throw error;
  }
}

function failClosed(error) {
  if (stopping) return;
  stopping = true;
  try {
    fs.writeFileSync(FAILED_FILE, `${error?.stack ?? error}\n`, {
      mode: 0o600,
    });
  } catch {}
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  for (const scheduler of rescanSchedulers.values()) scheduler.stop();
  rescanSchedulers.clear();
  if (periodicTimer) clearInterval(periodicTimer);
  closeRoots();
  try {
    process.kill(1, 'SIGTERM');
  } finally {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref();
  }
}

function rescanEventTarget(root, components) {
  const targetFd = openEventTarget(root, components);
  if (targetFd === null) return;
  normalizeTreeFromDescriptor(root, targetFd, true, false);
}

function handleEvent(root, relativeName) {
  if (stopping) return;
  const scheduler = rescanSchedulers.get(root.path);
  if (!scheduler) return;
  const components = relativeComponents(relativeName);
  if (!components) {
    scheduler.enqueueFull();
    return;
  }
  const stableComponents = components.map((component) =>
    Buffer.from(component),
  );
  const key = stableComponents
    .map((component) => component.toString('hex'))
    .join('/');
  scheduler.enqueueTarget(key, stableComponents);
}

function startWatch(root) {
  const watcher = fs.watch(
    root.path,
    { recursive: true, encoding: 'buffer' },
    (_eventType, relativeName) => handleEvent(root, relativeName),
  );
  watcher.on('error', (error) => recoverRoot(root.path, error));
  watchers.set(root.path, watcher);
  rescanSchedulers.set(
    root.path,
    createBoundedRescanScheduler({
      runTarget: (components) => rescanEventTarget(root, components),
      runFull: () => normalizeRoot(root),
      onError: (error) => recoverRoot(root.path, error),
    }),
  );
}

function recoverRoot(rootPath, cause) {
  if (stopping) return;
  const root = roots.find((candidate) => candidate.path === rootPath);
  if (!root?.active) return failClosed(cause);
  watchers.get(rootPath)?.close();
  watchers.delete(rootPath);
  rescanSchedulers.get(rootPath)?.stop();
  rescanSchedulers.delete(rootPath);
  const failures = (recoveryFailures.get(rootPath) ?? 0) + 1;
  recoveryFailures.set(rootPath, failures);
  try {
    // An overflow, missing filename or watch error loses incremental authority.
    // Scan before and after re-registration to close the complete gap.
    normalizeRoot(root);
    startWatch(root);
    normalizeRoot(root);
    recoveryFailures.set(rootPath, 0);
  } catch (error) {
    if (failures >= MAX_RECOVERY_FAILURES) return failClosed(error);
    setTimeout(() => recoverRoot(rootPath, error), 250).unref();
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (periodicTimer) clearInterval(periodicTimer);
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  for (const scheduler of rescanSchedulers.values()) scheduler.stop();
  rescanSchedulers.clear();
  try {
    normalizeAll();
    closeRoots();
    process.exit(0);
  } catch (error) {
    closeRoots();
    process.stderr.write(
      `happyclaw permission watcher final scan failed: ${error}\n`,
    );
    process.exit(1);
  }
}

try {
  initializeRoots();
  normalizeAll();
  if (process.argv.includes('--once') || oneShotOperationCount > 0) {
    closeRoots();
    process.exit(0);
  }
  for (const root of roots) {
    if (root.active) startWatch(root);
  }
  normalizeAll();
  fs.writeFileSync(READY_FILE, 'ready\n', { mode: 0o600 });
  periodicTimer = setInterval(() => {
    try {
      normalizeAll();
    } catch (error) {
      failClosed(error);
    }
  }, RESCAN_INTERVAL_MS);
  periodicTimer.unref();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  failClosed(error);
}
