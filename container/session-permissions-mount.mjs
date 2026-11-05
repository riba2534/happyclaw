import fs from 'node:fs';

export function parseDescriptorMountId(fdInfo) {
  if (typeof fdInfo !== 'string') {
    throw new Error('descriptor mount metadata is not text');
  }
  const matches = [...fdInfo.matchAll(/^mnt_id:\s+([0-9]+)\s*$/gm)];
  if (matches.length !== 1) {
    throw new Error('descriptor mount metadata has no unique mnt_id');
  }
  const mountId = Number(matches[0][1]);
  if (!Number.isSafeInteger(mountId) || mountId <= 0) {
    throw new Error('descriptor mount metadata has an invalid mnt_id');
  }
  return mountId;
}

export function readDescriptorMountId(fd, readFile = fs.readFileSync) {
  const fdInfo = readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
  return parseDescriptorMountId(fdInfo);
}

// A nested bind of a network share goes stale when the host replaces the share
// mount underneath it: every lookup of that entry then fails with ESTALE (Linux
// NFS) or EBADF (VM file sharing such as OrbStack's virtiofs), for the Agent as
// much as for the watcher. Nothing behind it can be read or written, so there
// is nothing to normalize. EBADF counts only while the parent descriptor is
// still open; a closed parent is the watcher's own bug and must still throw.
export function isStaleMountEntryError(error, parentFd, fstat = fs.fstatSync) {
  if (error?.code === 'ESTALE') return true;
  if (error?.code !== 'EBADF') return false;
  try {
    fstat(parentFd);
  } catch (parentError) {
    if (parentError?.code === 'EBADF') return false;
    throw parentError;
  }
  return true;
}
