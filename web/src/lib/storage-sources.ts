import { api } from '../api/client';

/**
 * An NFS export or SMB share workspaces can mount (never the password). Sources
 * added on the settings page have origin 'web'; the ones the mount allowlist
 * file declares are read-only here.
 */
export interface StorageSource {
  id: string;
  type: 'nfs' | 'cifs';
  server: string;
  exportPath?: string;
  nfsVersion?: '3' | '4' | '4.1' | '4.2';
  share?: string;
  username?: string;
  domain?: string;
  smbVersion?: '2.1' | '3.0' | '3.1.1';
  allowReadWrite: boolean;
  description?: string;
  hasPassword: boolean;
  origin: 'allowlist' | 'web';
  /** Workspaces whose mounts name this source. */
  usedBy: number;
  /** Of those, the ones that mount it read-write. */
  readWriteUsedBy: number;
}

export interface StorageSourceList {
  sources: StorageSource[];
  allowlistPath: string;
  /** Where sources added on the settings page are stored. */
  managedPath: string;
  nonMainReadOnly: boolean;
  allowlistError?: string;
  managedError?: string;
}

export interface StorageSourceSave {
  type: 'nfs' | 'cifs';
  server: string;
  exportPath?: string;
  nfsVersion?: string;
  share?: string;
  username?: string;
  domain?: string;
  smbVersion?: string;
  allowReadWrite: boolean;
  description?: string;
  /** Omitted keeps the stored password; '' removes it. */
  password?: string;
}

export const STORAGE_SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const BASE = '/api/config/storage-sources';

export function listStorageSources(): Promise<StorageSourceList> {
  return api.get<StorageSourceList>(BASE);
}

export function createStorageSource(
  id: string,
  input: StorageSourceSave,
): Promise<{ source: StorageSource }> {
  return api.post(`${BASE}/${encodeURIComponent(id)}`, input);
}

export function updateStorageSource(
  id: string,
  input: StorageSourceSave,
): Promise<{ source: StorageSource }> {
  return api.put(`${BASE}/${encodeURIComponent(id)}`, input);
}

export function deleteStorageSource(id: string): Promise<{ success: true }> {
  return api.delete(`${BASE}/${encodeURIComponent(id)}`);
}

/** What the source points at, e.g. `nfs://nas.lan/volume1` or `smb://nas/team`. */
export function storageSourceLocation(source: StorageSource): string {
  return source.type === 'nfs'
    ? `nfs://${source.server}${source.exportPath ?? ''}`
    : `smb://${source.server}/${source.share ?? ''}`;
}
