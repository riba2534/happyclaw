import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_IPC_WATCHER_FALLBACK_MS = 2000;
/**
 * Full-tree sweep for namespaces without a live runner (crash leftovers,
 * stale results). Live runners are covered
 * by their own watchers plus the fast fallback, so this can be slow: the
 * full walk costs O(every session ever created) directory reads.
 */
export const DEFAULT_IPC_ORPHAN_SWEEP_MS = 30_000;

/** One session's IPC root, `{ipcBaseDir}/{folder}/agents/{agentId}`. */
export interface IpcRuntimeNamespace {
  agentId: string;
}

export interface IpcWatcherErrorContext {
  phase: 'process_group' | 'fallback_scan';
  folder?: string;
}

export interface IpcWatcherManagerOptions {
  ipcBaseDir: string;
  isShuttingDown: () => boolean;
  onError?: (error: unknown, context: IpcWatcherErrorContext) => void;
  debounceMs?: number;
  /** Fast poll of namespaces that have a live runner. */
  fallbackMs?: number;
  /** Slow full sweep of every namespace under the IPC base directory. */
  orphanSweepMs?: number;
}

/**
 * Which IPC roots of one workspace folder to drain. `all` walks every
 * `agents/*` namespace; otherwise only the listed namespaces are read, so one
 * runner's request no longer costs a directory read per historical session of
 * the workspace.
 */
export type IpcProcessScope =
  | { all: true }
  | { all: false; namespaces: IpcRuntimeNamespace[] };

interface RuntimeWatchEntry {
  folder: string;
  namespace: IpcRuntimeNamespace;
  watchers: fs.FSWatcher[];
  refCount: number;
}

interface PendingScope {
  all: boolean;
  namespaces: Map<string, IpcRuntimeNamespace>;
}

function isSafeNamespaceSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

/** Concrete IPC roots for a scoped drain. */
export function resolveScopedIpcRoots(
  groupIpcRoot: string,
  namespaces: IpcRuntimeNamespace[],
): Array<{ path: string; agentId: string }> {
  const roots: Array<{ path: string; agentId: string }> = [];
  const seen = new Set<string>();
  for (const { agentId } of namespaces) {
    if (!isSafeNamespaceSegment(agentId) || seen.has(agentId)) continue;
    seen.add(agentId);
    roots.push({ path: path.join(groupIpcRoot, 'agents', agentId), agentId });
  }
  return roots;
}

/**
 * Event-driven watcher for every concrete IPC runtime namespace.
 *
 * Each session runner mounts its own root; watching only the workspace-level
 * directory would leave nested requests dependent on the slow full-scan
 * fallback. Entries are reference
 * counted because provider fallback and overlapping warm turns can briefly
 * share the same namespace.
 */
export class IpcWatcherManager {
  private readonly watchers = new Map<string, RuntimeWatchEntry>();
  private readonly debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly processingFolders = new Set<string>();
  /** Scope collected while the folder's debounce timer is armed. */
  private readonly pendingScopes = new Map<string, PendingScope>();
  /** Scope requested while the folder was already being processed. */
  private readonly pendingReprocess = new Map<string, PendingScope>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private processGroupFn:
    | ((folder: string, scope: IpcProcessScope) => Promise<void>)
    | null = null;
  private processFullFn: (() => Promise<void>) | null = null;

  constructor(private readonly options: IpcWatcherManagerOptions) {}

  bind(
    processGroup: (folder: string, scope: IpcProcessScope) => Promise<void>,
    processFull: () => Promise<void>,
  ): void {
    this.processGroupFn = processGroup;
    this.processFullFn = processFull;
  }

  private namespaceKey(namespace: IpcRuntimeNamespace): string {
    return `agent:${namespace.agentId}`;
  }

  private runtimeKey(folder: string, namespace: IpcRuntimeNamespace): string {
    return `${folder}\0${this.namespaceKey(namespace)}`;
  }

  /** True while at least one live runner holds this exact namespace. */
  isWatched(folder: string, namespace: IpcRuntimeNamespace): boolean {
    return this.watchers.has(this.runtimeKey(folder, namespace));
  }

  private runtimeRoot(folder: string, namespace: IpcRuntimeNamespace): string {
    return path.join(
      this.options.ipcBaseDir,
      folder,
      'agents',
      namespace.agentId,
    );
  }

  /** Acquire watchers for the exact root mounted into one runner. */
  watchRuntime(folder: string, namespace: IpcRuntimeNamespace): void {
    const key = this.runtimeKey(folder, namespace);
    const existing = this.watchers.get(key);
    if (existing) {
      existing.refCount += 1;
      return;
    }

    const root = this.runtimeRoot(folder, namespace);
    const runtimeNamespace: IpcRuntimeNamespace = {
      agentId: namespace.agentId,
    };
    const runtimeWatchers: fs.FSWatcher[] = [];
    for (const dir of [path.join(root, 'messages'), path.join(root, 'tasks')]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const watcher = fs.watch(dir, () =>
          this.debouncedProcess(folder, runtimeNamespace),
        );
        watcher.on('error', () => {
          // The periodic full scan remains the recovery path for an invalidated
          // platform watcher. Avoid throwing from EventEmitter error handlers.
        });
        runtimeWatchers.push(watcher);
      } catch {
        // The periodic full scan remains the fallback when fs.watch is absent.
      }
    }
    this.watchers.set(key, {
      folder,
      namespace: runtimeNamespace,
      watchers: runtimeWatchers,
      refCount: 1,
    });
    // Close the creation race: a freshly spawned child can atomically publish
    // its first request between mkdir and fs.watch registration. An immediate
    // guarded drain observes that file without waiting for fallback polling.
    this.debouncedProcess(folder, runtimeNamespace);
  }

  /** Release one runtime acquisition and close its leaf watchers at zero. */
  unwatchRuntime(folder: string, namespace: IpcRuntimeNamespace): void {
    const key = this.runtimeKey(folder, namespace);
    const entry = this.watchers.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    for (const watcher of entry.watchers) {
      try {
        watcher.close();
      } catch {
        // Already closed by the platform.
      }
    }
    this.watchers.delete(key);
    // A runner can publish its last request and exit before the debounced
    // watcher event fires. Drain the released namespace once more so that
    // request does not wait for the slow orphan sweep.
    this.debouncedProcess(folder, entry.namespace);
  }

  private mergeScope(
    target: Map<string, PendingScope>,
    folder: string,
    namespace: IpcRuntimeNamespace | 'all',
  ): void {
    let scope = target.get(folder);
    if (!scope) {
      scope = { all: false, namespaces: new Map() };
      target.set(folder, scope);
    }
    if (namespace === 'all') {
      scope.all = true;
      scope.namespaces.clear();
    } else if (!scope.all) {
      scope.namespaces.set(this.namespaceKey(namespace), namespace);
    }
  }

  private debouncedProcess(
    folder: string,
    namespace: IpcRuntimeNamespace | 'all',
  ): void {
    if (this.closed) return;
    this.mergeScope(this.pendingScopes, folder, namespace);
    const existing = this.debounceTimers.get(folder);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      folder,
      setTimeout(() => {
        this.debounceTimers.delete(folder);
        const pending = this.pendingScopes.get(folder);
        this.pendingScopes.delete(folder);
        if (!pending) return;
        if (this.processingFolders.has(folder)) {
          if (pending.all) {
            this.mergeScope(this.pendingReprocess, folder, 'all');
          } else {
            for (const ns of pending.namespaces.values()) {
              this.mergeScope(this.pendingReprocess, folder, ns);
            }
          }
          return;
        }
        const scope: IpcProcessScope = pending.all
          ? { all: true }
          : { all: false, namespaces: [...pending.namespaces.values()] };
        this.processingFolders.add(folder);
        Promise.resolve()
          .then(() => this.processGroupFn?.(folder, scope))
          .catch((error) => {
            this.options.onError?.(error, {
              phase: 'process_group',
              folder,
            });
          })
          .finally(() => {
            this.processingFolders.delete(folder);
            const again = this.pendingReprocess.get(folder);
            this.pendingReprocess.delete(folder);
            if (!again || this.closed) return;
            if (again.all) {
              this.debouncedProcess(folder, 'all');
            } else {
              for (const ns of again.namespaces.values()) {
                this.debouncedProcess(folder, ns);
              }
            }
          });
      }, this.options.debounceMs ?? 100),
    );
  }

  /** Drain one namespace, or every namespace of the folder when omitted. */
  triggerProcess(folder: string, namespace?: IpcRuntimeNamespace): void {
    this.debouncedProcess(folder, namespace ?? 'all');
  }

  startFallback(): void {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => {
      if (this.options.isShuttingDown()) return;
      // Keep the recovery poll comfortably below the Runner's bounded context
      // IPC deadline. A 5s fallback paired with a 5s Runner timeout was a
      // deterministic race even after adding a final deadline read, because the
      // Host still debounces the discovered folder before processing it.
      // Only live namespaces can have a Runner waiting on that deadline.
      for (const entry of this.watchers.values()) {
        this.debouncedProcess(entry.folder, entry.namespace);
      }
    }, this.options.fallbackMs ?? DEFAULT_IPC_WATCHER_FALLBACK_MS);
    this.fallbackTimer.unref();
    this.sweepTimer = setInterval(() => {
      if (this.options.isShuttingDown()) return;
      this.processFullFn?.().catch((error) => {
        this.options.onError?.(error, { phase: 'fallback_scan' });
      });
    }, this.options.orphanSweepMs ?? DEFAULT_IPC_ORPHAN_SWEEP_MS);
    this.sweepTimer.unref();
  }

  closeAll(): void {
    this.closed = true;
    for (const entry of this.watchers.values()) {
      for (const watcher of entry.watchers) {
        try {
          watcher.close();
        } catch {
          // Already closed by the platform.
        }
      }
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.pendingScopes.clear();
    this.processingFolders.clear();
    this.pendingReprocess.clear();
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Test/diagnostic visibility for leak assertions. */
  get activeRuntimeCount(): number {
    return this.watchers.size;
  }
}
