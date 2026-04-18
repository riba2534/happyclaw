import { create } from 'zustand';
import { api, apiFetch } from '../api/client';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  absolutePath?: string;
}

export interface UploadProgress {
  total: number;
  completed: number;
  currentFile: string;
  /** bytes for current batch */
  totalBytes: number;
  uploadedBytes: number;
}

interface FileState {
  files: Record<string, FileEntry[]>;
  currentPath: Record<string, string>;
  loading: boolean;
  uploading: boolean;
  uploadProgress: UploadProgress | null;
  error: string | null;

  loadFiles: (jid: string, path?: string) => Promise<void>;
  uploadFiles: (jid: string, files: File[], basePath?: string) => Promise<boolean>;
  deleteFile: (jid: string, filePath: string) => Promise<boolean>;
  createDirectory: (jid: string, parentPath: string, name: string) => Promise<void>;
  navigateTo: (jid: string, path: string) => void;
  getFileContent: (jid: string, filePath: string) => Promise<string | null>;
  saveFileContent: (jid: string, filePath: string, content: string) => Promise<boolean>;
}

export function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const useFileStore = create<FileState>((set, get) => ({
  files: {},
  currentPath: {},
  loading: false,
  uploading: false,
  uploadProgress: null,
  error: null,

  loadFiles: async (jid: string, path?: string) => {
    set({ loading: true, error: null });
    try {
      const targetPath = path !== undefined ? path : (get().currentPath[jid] || '');
      const params = new URLSearchParams();
      if (targetPath) params.set('path', targetPath);

      const data = await api.get<{ files: FileEntry[]; currentPath: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files?${params}`
      );

      set((s) => ({
        files: { ...s.files, [jid]: data.files },
        currentPath: { ...s.currentPath, [jid]: data.currentPath },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load files';
      console.error('Failed to load files:', err);
      set({ loading: false, error: msg });
    }
  },

  uploadFiles: async (jid: string, files: File[], basePath?: string) => {
    if (files.length === 0) return false;

    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    set({
      uploading: true,
      uploadProgress: { total, completed: 0, currentFile: files[0].name, totalBytes, uploadedBytes: 0 },
    });

    const targetBase = basePath !== undefined ? basePath : (get().currentPath[jid] || '');
    const apiUrl = `/api/groups/${encodeURIComponent(jid)}/files`;
    let uploadedBytes = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // For folder uploads, webkitRelativePath = "folderName/sub/file.txt"
        // Extract directory portion to preserve structure
        const relativePath = file.webkitRelativePath;
        let uploadPath = targetBase;
        if (relativePath) {
          const lastSlash = relativePath.lastIndexOf('/');
          if (lastSlash > 0) {
            const dir = relativePath.substring(0, lastSlash);
            uploadPath = targetBase ? `${targetBase}/${dir}` : dir;
          }
        }

        set({
          uploadProgress: { total, completed: i, currentFile: file.name, totalBytes, uploadedBytes },
        });

        const formData = new FormData();
        formData.append('files', file);
        if (uploadPath) formData.append('path', uploadPath);

        await apiFetch(apiUrl, {
          method: 'POST',
          body: formData,
          headers: {},
        });

        uploadedBytes += file.size;

        set({
          uploadProgress: { total, completed: i + 1, currentFile: i + 1 < total ? files[i + 1].name : '', totalBytes, uploadedBytes },
        });
      }

      // Reload file list
      await get().loadFiles(jid, targetBase);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to upload files';
      console.error('Failed to upload files:', err);
      set({ error: msg });
      return false;
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
  },

  deleteFile: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.delete(`/api/groups/${encodeURIComponent(jid)}/files/${encoded}`);

      const currentPath = get().currentPath[jid] || '';
      await get().loadFiles(jid, currentPath);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete file';
      console.error('Failed to delete file:', err);
      set({ error: msg });
      return false;
    }
  },

  createDirectory: async (jid: string, parentPath: string, name: string) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/directories`, {
        path: parentPath,
        name,
      });

      await get().loadFiles(jid, parentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create directory';
      console.error('Failed to create directory:', err);
      set({ error: msg });
    }
  },

  navigateTo: (jid: string, path: string) => {
    set((s) => ({
      currentPath: { ...s.currentPath, [jid]: path },
      files: { ...s.files, [jid]: [] },
    }));
    get().loadFiles(jid, path);
  },

  getFileContent: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      const data = await api.get<{ content: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`
      );
      return data.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to read file';
      console.error('Failed to read file content:', err);
      set({ error: msg });
      return null;
    }
  },

  saveFileContent: async (jid: string, filePath: string, content: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.put(`/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`, { content });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Failed to save file content:', err);
      set({ error: msg });
      return false;
    }
  },
}));
