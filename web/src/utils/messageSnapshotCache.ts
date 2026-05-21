import type { Message } from '../stores/chat';

const DB_NAME = 'happyclaw-message-snapshots';
const DB_VERSION = 1;
const AGENT_MESSAGES_STORE = 'agentMessages';
const MAX_MESSAGES_PER_AGENT = 100;

interface AgentMessageSnapshot {
  key: string;
  jid: string;
  agentId: string;
  messages: Message[];
  hasMore: boolean;
  updatedAt: number;
}

function canUseIndexedDB(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function agentSnapshotKey(jid: string, agentId: string): string {
  return `${jid}#agent:${agentId}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openSnapshotDb(): Promise<IDBDatabase> {
  if (!canUseIndexedDB()) return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AGENT_MESSAGES_STORE)) {
        const store = db.createObjectStore(AGENT_MESSAGES_STORE, { keyPath: 'key' });
        store.createIndex('jid', 'jid', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    // Reset the cached promise on failure so a later call can retry. Otherwise
    // a single transient IDB error (Safari ITP eviction, private-mode quota
    // refusal, ...) would poison every subsequent snapshot read/write until
    // the page is reloaded.
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('IndexedDB upgrade blocked'));
    };
  });

  return dbPromise;
}

function runAgentStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openSnapshotDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(AGENT_MESSAGES_STORE, mode);
    const request = action(tx.objectStore(AGENT_MESSAGES_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    // Quota-exceeded triggers abort (not error). Without this, the
    // returned promise hangs forever on storage pressure.
    tx.onabort = () => reject(tx.error);
  }));
}

function normalizeSnapshotMessages(messages: Message[]): Message[] {
  return [...messages]
    .sort((a, b) => {
      if (a.timestamp === b.timestamp) return a.id.localeCompare(b.id);
      return a.timestamp.localeCompare(b.timestamp);
    })
    .slice(-MAX_MESSAGES_PER_AGENT);
}

/**
 * Persist the latest known app-state snapshot for a conversation agent.
 *
 * This is intentionally an application cache (IndexedDB), not a Workbox HTTP
 * response cache: WebSocket-delivered state is fresher than the last HTTP
 * response but still needs to survive a page reload.
 */
export async function saveAgentMessageSnapshot(
  jid: string,
  agentId: string,
  messages: Message[],
  hasMore: boolean,
): Promise<void> {
  if (!canUseIndexedDB()) return;
  const snapshot: AgentMessageSnapshot = {
    key: agentSnapshotKey(jid, agentId),
    jid,
    agentId,
    messages: normalizeSnapshotMessages(messages),
    hasMore,
    updatedAt: Date.now(),
  };
  try {
    await runAgentStore('readwrite', (store) => store.put(snapshot));
  } catch {
    /* best effort */
  }
}

export async function loadAgentMessageSnapshot(
  jid: string,
  agentId: string,
): Promise<Pick<AgentMessageSnapshot, 'messages' | 'hasMore'> | null> {
  if (!canUseIndexedDB()) return null;
  try {
    const snapshot = await runAgentStore<AgentMessageSnapshot | undefined>(
      'readonly',
      (store) => store.get(agentSnapshotKey(jid, agentId)),
    );
    if (!snapshot || snapshot.jid !== jid || snapshot.agentId !== agentId) {
      return null;
    }
    return {
      messages: normalizeSnapshotMessages(snapshot.messages || []),
      hasMore: !!snapshot.hasMore,
    };
  } catch {
    return null;
  }
}

export async function deleteAgentMessageSnapshot(
  jid: string,
  agentId: string,
): Promise<void> {
  if (!canUseIndexedDB()) return;
  try {
    await runAgentStore('readwrite', (store) => store.delete(agentSnapshotKey(jid, agentId)));
  } catch {
    /* best effort */
  }
}

export async function deleteGroupMessageSnapshots(jid: string): Promise<void> {
  if (!canUseIndexedDB()) return;
  try {
    const db = await openSnapshotDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AGENT_MESSAGES_STORE, 'readwrite');
      const store = tx.objectStore(AGENT_MESSAGES_STORE);
      const index = store.index('jid');
      const request = index.openKeyCursor(IDBKeyRange.only(jid));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* best effort */
  }
}

export async function clearMessageSnapshotCache(): Promise<void> {
  if (!canUseIndexedDB()) return;
  try {
    await runAgentStore('readwrite', (store) => store.clear());
  } catch {
    /* best effort */
  }
}
