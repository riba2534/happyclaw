import crypto from 'node:crypto';

interface SqliteRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

let database: SqliteDatabase | null = null;

export type WorkspaceMemoryKind = 'fact' | 'decision' | 'lesson' | 'open_loop';

export type WorkspaceMemoryStatus =
  | 'active'
  | 'proposed'
  | 'conflicted'
  | 'superseded'
  | 'deleted';

export type WorkspaceMemoryChangeType = 'create' | 'update' | 'forget';

export type WorkspaceMemorySourceType =
  | 'web_user'
  | 'agent_runtime'
  | 'scheduled_task'
  | 'migration';

/** One durable Home Workspace fact completes HappyClaw's first-wake ritual. */
export const HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY =
  'happyclaw.owner.preferred_address';
const HAPPYCLAW_OWNER_PROFILE_MEMORY_NAMESPACE = 'happyclaw.owner-profile';

export interface WorkspaceMemoryProvenance {
  sourceType: WorkspaceMemorySourceType;
  sourceId: string | null;
  sessionId: string | null;
  observedAt: string | null;
}

export interface WorkspaceMemoryItem {
  id: string;
  workspaceJid: string;
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  canonicalKey: string | null;
  status: WorkspaceMemoryStatus;
  importance: number;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  provenance: WorkspaceMemoryProvenance;
}

export interface WorkspaceMemoryVersion extends Omit<
  WorkspaceMemoryItem,
  'revision' | 'updatedAt' | 'deletedAt'
> {
  revision: number;
  changeType: WorkspaceMemoryChangeType;
  createdAt: string;
  actor: {
    type: WorkspaceMemorySourceType;
    id: string;
  };
}

export interface WorkspaceMemoryStore {
  id: string;
  workspaceJid: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMemoryMutationContext {
  actorId: string;
  sourceType: WorkspaceMemorySourceType;
  sourceId?: string | null;
  sessionId?: string | null;
  observedAt?: string | null;
}

export interface WorkspaceMemoryValue {
  kind: WorkspaceMemoryKind;
  title?: string | null;
  content: string;
  canonicalKey?: string | null;
  status?: Exclude<WorkspaceMemoryStatus, 'deleted'>;
  importance?: number;
  confidence?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
}

interface MemoryItemRow {
  id: string;
  workspace_jid: string;
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  canonical_key: string | null;
  status: WorkspaceMemoryStatus;
  importance: number;
  confidence: number;
  valid_from: string | null;
  valid_until: string | null;
  expires_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  source_type: WorkspaceMemorySourceType | null;
  source_id: string | null;
  session_id: string | null;
  observed_at: string | null;
}

interface MemoryVersionRow extends MemoryItemRow {
  change_type: WorkspaceMemoryChangeType;
  actor_type: WorkspaceMemorySourceType;
  actor_id: string;
}

export class WorkspaceMemoryStoreError extends Error {
  constructor(
    public readonly code:
      | 'store_not_found'
      | 'item_not_found'
      | 'revision_conflict'
      | 'idempotency_conflict'
      | 'reserved_canonical_key',
    message: string,
    public readonly details?: {
      currentRevision?: number;
      storeRevision?: number;
    },
  ) {
    super(message);
    this.name = 'WorkspaceMemoryStoreError';
  }
}

function requireDatabase(): SqliteDatabase {
  if (!database) {
    throw new Error('Workspace memory store is not initialized');
  }
  return database;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isReservedCanonicalKey(value: string | null | undefined): boolean {
  return (
    normalizeNullable(value) === HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY
  );
}

function rejectReservedCanonicalKey(value: string | null | undefined): void {
  if (!isReservedCanonicalKey(value)) return;
  throw new WorkspaceMemoryStoreError(
    'reserved_canonical_key',
    'This canonical key is owned by the HappyClaw Owner Profile service',
  );
}

function mapItem(row: MemoryItemRow): WorkspaceMemoryItem {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    kind: row.kind,
    title: row.title,
    content: row.content,
    canonicalKey: row.canonical_key,
    status: row.status,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    expiresAt: row.expires_at,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    provenance: {
      sourceType: row.source_type ?? 'migration',
      sourceId: row.source_id,
      sessionId: row.session_id,
      observedAt: row.observed_at,
    },
  };
}

function mapVersion(row: MemoryVersionRow): WorkspaceMemoryVersion {
  const item = mapItem(row);
  return {
    id: item.id,
    workspaceJid: item.workspaceJid,
    kind: item.kind,
    title: item.title,
    content: item.content,
    canonicalKey: item.canonicalKey,
    status: item.status,
    importance: item.importance,
    confidence: item.confidence,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    expiresAt: item.expiresAt,
    revision: item.revision,
    changeType: row.change_type,
    createdAt: row.created_at,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
    },
    provenance: item.provenance,
  };
}

function storeRow(workspaceJid: string): {
  id: string;
  workspace_jid: string;
  revision: number;
  created_at: string;
  updated_at: string;
} | null {
  return (
    (requireDatabase()
      .prepare(
        `SELECT id, workspace_jid, revision, created_at, updated_at
         FROM workspace_memory_stores WHERE workspace_jid = ?`,
      )
      .get(workspaceJid) as ReturnType<typeof storeRow>) ?? null
  );
}

function mapStore(
  row: NonNullable<ReturnType<typeof storeRow>>,
): WorkspaceMemoryStore {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireStore(workspaceJid: string): WorkspaceMemoryStore {
  const row = storeRow(workspaceJid);
  if (!row) {
    throw new WorkspaceMemoryStoreError(
      'store_not_found',
      'Workspace memory store not found',
    );
  }
  return mapStore(row);
}

const ITEM_SELECT = `
  SELECT i.*,
    p.source_type, p.source_id, p.session_id, p.observed_at
  FROM workspace_memory_items i
  LEFT JOIN workspace_memory_provenance p
    ON p.item_id = i.id AND p.revision = i.revision
`;

function itemRow(storeId: string, itemId: string): MemoryItemRow | null {
  return (
    (requireDatabase()
      .prepare(`${ITEM_SELECT} WHERE i.store_id = ? AND i.id = ?`)
      .get(storeId, itemId) as MemoryItemRow | undefined) ?? null
  );
}

function requireItem(
  store: WorkspaceMemoryStore,
  itemId: string,
): WorkspaceMemoryItem {
  const row = itemRow(store.id, itemId);
  if (!row) {
    throw new WorkspaceMemoryStoreError(
      'item_not_found',
      'Workspace memory item not found',
    );
  }
  return mapItem(row);
}

/**
 * Duplicate reconciliation clears the losing row's current canonical key so a
 * cross-status unique index can be installed. Its immutable versions still
 * mark the row as platform-owned; generic APIs must continue treating it as a
 * reserved item rather than exposing the retired preferred address.
 */
function isReservedMemoryItem(item: WorkspaceMemoryItem): boolean {
  if (isReservedCanonicalKey(item.canonicalKey)) return true;
  return Boolean(
    requireDatabase()
      .prepare(
        `SELECT 1
         FROM workspace_memory_platform_items
         WHERE item_id = ?
         UNION ALL
         SELECT 1
         FROM workspace_memory_versions
         WHERE item_id = ? AND canonical_key = ?
         LIMIT 1`,
      )
      .get(item.id, item.id, HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY),
  );
}

function markPlatformMemoryItem(itemId: string, at: string): void {
  requireDatabase()
    .prepare(
      `INSERT OR IGNORE INTO workspace_memory_platform_items (
        item_id, namespace, created_at
      ) VALUES (?, ?, ?)`,
    )
    .run(itemId, HAPPYCLAW_OWNER_PROFILE_MEMORY_NAMESPACE, at);
}

function rejectReservedMemoryItem(item: WorkspaceMemoryItem): void {
  if (!isReservedMemoryItem(item)) return;
  throw new WorkspaceMemoryStoreError(
    'reserved_canonical_key',
    'This memory item is owned by the HappyClaw Owner Profile service',
  );
}

function appendVersion(
  item: WorkspaceMemoryItem,
  changeType: WorkspaceMemoryChangeType,
  context: WorkspaceMemoryMutationContext,
  at: string,
): void {
  const db = requireDatabase();
  db.prepare(
    `INSERT INTO workspace_memory_versions (
      item_id, revision, workspace_jid, kind, title, content, canonical_key,
      status, importance, confidence, valid_from, valid_until, expires_at,
      change_type, actor_type, actor_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.revision,
    item.workspaceJid,
    item.kind,
    item.title,
    item.content,
    item.canonicalKey,
    item.status,
    item.importance,
    item.confidence,
    item.validFrom,
    item.validUntil,
    item.expiresAt,
    changeType,
    context.sourceType,
    context.actorId,
    at,
  );
  db.prepare(
    `INSERT INTO workspace_memory_provenance (
      item_id, revision, source_type, source_id, session_id, observed_at,
      recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.revision,
    context.sourceType,
    normalizeNullable(context.sourceId),
    normalizeNullable(context.sessionId),
    context.observedAt ?? null,
    at,
  );
}

function appendAuditAndOutbox(
  store: WorkspaceMemoryStore,
  item: WorkspaceMemoryItem,
  action: WorkspaceMemoryChangeType,
  context: WorkspaceMemoryMutationContext,
  at: string,
): void {
  const db = requireDatabase();
  db.prepare(
    `INSERT INTO workspace_memory_audit_events (
      id, workspace_jid, store_id, item_id, item_revision, store_revision,
      action, actor_type, actor_id, source_id, session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('wma'),
    store.workspaceJid,
    store.id,
    item.id,
    item.revision,
    store.revision,
    action,
    context.sourceType,
    context.actorId,
    normalizeNullable(context.sourceId),
    normalizeNullable(context.sessionId),
    at,
  );
  db.prepare(
    `INSERT INTO workspace_memory_outbox (
      id, workspace_jid, store_id, item_id, item_revision, event_type,
      payload_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    newId('wmo'),
    store.workspaceJid,
    store.id,
    item.id,
    item.revision,
    action === 'forget' ? 'memory.forgotten' : `memory.${action}d`,
    JSON.stringify({
      workspaceJid: store.workspaceJid,
      storeRevision: store.revision,
      itemId: item.id,
      itemRevision: item.revision,
      status: item.status,
    }),
    at,
    at,
  );
}

function replaceFts(item: WorkspaceMemoryItem): void {
  const db = requireDatabase();
  db.prepare('DELETE FROM workspace_memory_fts WHERE item_id = ?').run(item.id);
  if (item.status !== 'active' || isReservedMemoryItem(item)) {
    return;
  }
  db.prepare(
    `INSERT INTO workspace_memory_fts (
      item_id, workspace_jid, title, content, canonical_key
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.workspaceJid,
    item.title ?? '',
    item.content,
    item.canonicalKey ?? '',
  );
}

function bumpStore(storeId: string, at: string): WorkspaceMemoryStore {
  const db = requireDatabase();
  db.prepare(
    `UPDATE workspace_memory_stores
     SET revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(at, storeId);
  const row = db
    .prepare(
      `SELECT id, workspace_jid, revision, created_at, updated_at
       FROM workspace_memory_stores WHERE id = ?`,
    )
    .get(storeId) as NonNullable<ReturnType<typeof storeRow>>;
  return mapStore(row);
}

export function createWorkspaceMemorySchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_memory_stores (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_memory_items (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'lesson', 'open_loop')),
      title TEXT,
      content TEXT NOT NULL,
      canonical_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'proposed', 'conflicted', 'superseded', 'deleted')),
      importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
      confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      create_idempotency_key TEXT,
      create_request_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (store_id) REFERENCES workspace_memory_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      UNIQUE (store_id, create_idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_store_status_updated
      ON workspace_memory_items(store_id, status, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_workspace_kind
      ON workspace_memory_items(workspace_jid, kind, status);
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_validity
      ON workspace_memory_items(store_id, valid_from, valid_until, expires_at);

    CREATE TABLE IF NOT EXISTS workspace_memory_versions (
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      workspace_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      canonical_key TEXT,
      status TEXT NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'forget')),
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, revision),
      FOREIGN KEY (item_id) REFERENCES workspace_memory_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_versions_workspace_created
      ON workspace_memory_versions(workspace_jid, created_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_memory_platform_items (
      item_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES workspace_memory_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_platform_namespace
      ON workspace_memory_platform_items(namespace, item_id);

    CREATE TABLE IF NOT EXISTS workspace_memory_provenance (
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('web_user', 'agent_runtime', 'scheduled_task', 'migration')),
      source_id TEXT,
      session_id TEXT,
      observed_at TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (item_id, revision),
      FOREIGN KEY (item_id, revision)
        REFERENCES workspace_memory_versions(item_id, revision) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_memory_tombstones (
      item_id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      deleted_revision INTEGER NOT NULL,
      reason TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES workspace_memory_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_memory_mutation_requests (
      store_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('update', 'forget')),
      item_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (store_id, idempotency_key),
      FOREIGN KEY (store_id) REFERENCES workspace_memory_stores(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_memory_outbox (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      store_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_outbox_pending
      ON workspace_memory_outbox(status, available_at, created_at);

    CREATE TABLE IF NOT EXISTS workspace_memory_audit_events (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      store_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_revision INTEGER NOT NULL,
      store_revision INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source_id TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_audit_workspace_created
      ON workspace_memory_audit_events(workspace_jid, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_memory_fts USING fts5(
      item_id UNINDEXED,
      workspace_jid UNINDEXED,
      title,
      content,
      canonical_key,
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS trg_workspace_memory_store_after_workspace_insert
    AFTER INSERT ON workspaces
    BEGIN
      INSERT OR IGNORE INTO workspace_memory_stores (
        id, workspace_jid, revision, created_at, updated_at
      ) VALUES (
        'wms_' || lower(hex(randomblob(16))),
        NEW.jid,
        0,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    INSERT OR IGNORE INTO workspace_memory_stores (
      id, workspace_jid, revision, created_at, updated_at
    )
    SELECT
      'wms_' || lower(hex(randomblob(16))),
      jid,
      0,
      created_at,
      updated_at
    FROM workspaces;

    INSERT OR IGNORE INTO workspace_memory_platform_items (
      item_id, namespace, created_at
    )
    SELECT
      id, 'happyclaw.owner-profile', created_at
    FROM workspace_memory_items
    WHERE canonical_key = 'happyclaw.owner.preferred_address';

    INSERT OR IGNORE INTO workspace_memory_platform_items (
      item_id, namespace, created_at
    )
    SELECT
      item_id, 'happyclaw.owner-profile', MIN(created_at)
    FROM workspace_memory_versions
    WHERE canonical_key = 'happyclaw.owner.preferred_address'
    GROUP BY item_id;
  `);
}

export function bindWorkspaceMemoryDatabase(db: SqliteDatabase | null): void {
  database = db;
}

/**
 * Reconcile old generic-memory writes before installing the reserved-key
 * uniqueness invariant. The most recently updated row wins deterministically;
 * status is deliberately not preferred because a newer clear/forget must not
 * be undone by an older active duplicate. Every duplicate is detached from
 * the reserved key with full version/audit/outbox history.
 */
export function reconcileHappyClawOwnerAddressCanonicalKey(): {
  workspaces: number;
  retiredItems: number;
} {
  const db = requireDatabase();
  return db.transaction(() => {
    const duplicateStores = db
      .prepare(
        `SELECT store_id
         FROM workspace_memory_items
         WHERE canonical_key = ?
         GROUP BY store_id
         HAVING COUNT(*) > 1`,
      )
      .all(HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY) as Array<{
      store_id: string;
    }>;
    let retiredItems = 0;
    for (const duplicate of duplicateStores) {
      const rows = db
        .prepare(
          `${ITEM_SELECT}
           WHERE i.store_id = ? AND i.canonical_key = ?
           ORDER BY i.updated_at DESC, i.revision DESC, i.id DESC`,
        )
        .all(
          duplicate.store_id,
          HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        ) as MemoryItemRow[];
      const storeRowValue = db
        .prepare(
          `SELECT id, workspace_jid, revision, created_at, updated_at
           FROM workspace_memory_stores WHERE id = ?`,
        )
        .get(duplicate.store_id) as
        | NonNullable<ReturnType<typeof storeRow>>
        | undefined;
      if (!storeRowValue) continue;
      let store = mapStore(storeRowValue);
      for (const loser of rows.slice(1)) {
        const at = nowIso();
        markPlatformMemoryItem(loser.id, loser.created_at || at);
        const result = db
          .prepare(
            `UPDATE workspace_memory_items
             SET canonical_key = NULL,
                 status = CASE
                   WHEN status = 'deleted' THEN 'deleted'
                   ELSE 'superseded'
                 END,
                 revision = revision + 1,
                 updated_at = ?
             WHERE store_id = ? AND id = ? AND revision = ?
               AND canonical_key = ?`,
          )
          .run(
            at,
            store.id,
            loser.id,
            loser.revision,
            HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
          );
        if (result.changes !== 1) continue;
        store = bumpStore(store.id, at);
        const versionItem = requireItem(store, loser.id);
        const context: WorkspaceMemoryMutationContext = {
          actorId: 'schema-v66-owner-profile-reconciliation',
          sourceType: 'migration',
          sourceId: 'happyclaw.owner.preferred_address',
          observedAt: at,
        };
        appendVersion(versionItem, 'update', context, at);
        const item = requireItem(store, loser.id);
        if (item.status === 'deleted') {
          db.prepare(
            `UPDATE workspace_memory_tombstones
             SET deleted_revision = ? WHERE item_id = ?`,
          ).run(item.revision, item.id);
        }
        replaceFts(item);
        appendAuditAndOutbox(store, item, 'update', context, at);
        retiredItems++;
      }
    }
    return { workspaces: duplicateStores.length, retiredItems };
  })();
}

/**
 * Must be called only after reconciliation. Keeping this outside
 * createWorkspaceMemorySchema is essential: an old database may contain
 * duplicates and would otherwise fail before the migration can repair them.
 */
export function enforceHappyClawOwnerAddressCanonicalInvariant(): void {
  requireDatabase()
    .prepare(
      `DELETE FROM workspace_memory_fts
       WHERE item_id IN (
         SELECT id FROM workspace_memory_items WHERE canonical_key = ?
         UNION
         SELECT item_id FROM workspace_memory_platform_items
         WHERE namespace = ?
       )`,
    )
    .run(
      HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      HAPPYCLAW_OWNER_PROFILE_MEMORY_NAMESPACE,
    );
  requireDatabase().exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_memory_owner_address_unique
      ON workspace_memory_items(store_id, canonical_key)
      WHERE canonical_key = 'happyclaw.owner.preferred_address';
  `);
}

/**
 * Remove every memory artifact for a deleted workspace explicitly.
 *
 * HappyClaw may temporarily disable SQLite foreign-key enforcement when a
 * legacy installation contains unrelated FK orphans. Deletion therefore must
 * not rely on ON DELETE CASCADE: leaving the store behind would let a future
 * workspace that reuses the same JID inherit another owner's memory.
 */
export function deleteWorkspaceMemoryData(workspaceJid: string): void {
  const db = requireDatabase();
  const store = storeRow(workspaceJid);
  if (!store) return;
  db.prepare('DELETE FROM workspace_memory_fts WHERE workspace_jid = ?').run(
    workspaceJid,
  );
  db.prepare(
    'DELETE FROM workspace_memory_audit_events WHERE workspace_jid = ?',
  ).run(workspaceJid);
  db.prepare('DELETE FROM workspace_memory_outbox WHERE workspace_jid = ?').run(
    workspaceJid,
  );
  db.prepare(
    'DELETE FROM workspace_memory_mutation_requests WHERE store_id = ?',
  ).run(store.id);
  db.prepare(
    'DELETE FROM workspace_memory_tombstones WHERE workspace_jid = ?',
  ).run(workspaceJid);
  db.prepare(
    `DELETE FROM workspace_memory_provenance
     WHERE item_id IN (
       SELECT id FROM workspace_memory_items WHERE store_id = ?
     )`,
  ).run(store.id);
  db.prepare(
    `DELETE FROM workspace_memory_versions
     WHERE item_id IN (
       SELECT id FROM workspace_memory_items WHERE store_id = ?
     )`,
  ).run(store.id);
  db.prepare(
    `DELETE FROM workspace_memory_platform_items
     WHERE item_id IN (
       SELECT id FROM workspace_memory_items WHERE store_id = ?
     )`,
  ).run(store.id);
  db.prepare('DELETE FROM workspace_memory_items WHERE store_id = ?').run(
    store.id,
  );
  db.prepare('DELETE FROM workspace_memory_stores WHERE id = ?').run(store.id);
}

/**
 * Replace a retained workspace's complete Memory lineage with a new empty
 * store. Workspace rebuild keeps the workspace row itself, so deleting the old
 * store without recreating it would leave Memory APIs in a permanent
 * store_not_found state.
 */
export function resetWorkspaceMemoryData(
  workspaceJid: string,
): WorkspaceMemoryStore {
  const db = requireDatabase();
  return db.transaction(() => {
    const workspace = db
      .prepare('SELECT 1 FROM workspaces WHERE jid = ?')
      .get(workspaceJid);
    if (!workspace) {
      throw new WorkspaceMemoryStoreError(
        'store_not_found',
        'Workspace memory store not found',
      );
    }

    deleteWorkspaceMemoryData(workspaceJid);
    const at = nowIso();
    db.prepare(
      `INSERT INTO workspace_memory_stores (
        id, workspace_jid, revision, created_at, updated_at
      ) VALUES (?, ?, 0, ?, ?)`,
    ).run(newId('wms'), workspaceJid, at, at);
    return requireStore(workspaceJid);
  })();
}

export function getWorkspaceMemoryStore(
  workspaceJid: string,
): WorkspaceMemoryStore | null {
  const row = storeRow(workspaceJid);
  return row ? mapStore(row) : null;
}

export function hasRecallableWorkspaceMemoryCanonicalKey(
  workspaceJid: string,
  canonicalKey: string,
  now: string = nowIso(),
): boolean {
  const store = storeRow(workspaceJid);
  if (!store) return false;
  const row = requireDatabase()
    .prepare(
      `SELECT 1
       FROM workspace_memory_items
       WHERE store_id = ?
         AND canonical_key = ?
         AND status = 'active'
         AND (valid_from IS NULL OR julianday(valid_from) <= julianday(?))
         AND (valid_until IS NULL OR julianday(valid_until) > julianday(?))
         AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
       LIMIT 1`,
    )
    .get(store.id, canonicalKey, now, now, now);
  return Boolean(row);
}

export function getWorkspaceMemoryItem(
  workspaceJid: string,
  itemId: string,
): { store: WorkspaceMemoryStore; item: WorkspaceMemoryItem } {
  const store = requireStore(workspaceJid);
  const item = requireItem(store, itemId);
  if (isReservedMemoryItem(item)) {
    throw new WorkspaceMemoryStoreError(
      'item_not_found',
      'Workspace memory item not found',
    );
  }
  return { store, item };
}

/** Mutation preflight that preserves the explicit reserved-key rejection code. */
export function getMutableWorkspaceMemoryItem(
  workspaceJid: string,
  itemId: string,
): { store: WorkspaceMemoryStore; item: WorkspaceMemoryItem } {
  const store = requireStore(workspaceJid);
  const item = requireItem(store, itemId);
  rejectReservedMemoryItem(item);
  return { store, item };
}

export interface ReservedWorkspaceMemoryMutationResult {
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
  changed: boolean;
}

/**
 * Read the platform-owned Owner Profile item without exposing it through the
 * generic Workspace Memory service.
 */
export function getHappyClawOwnerAddressMemoryItem(workspaceJid: string): {
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem | null;
} {
  const store = requireStore(workspaceJid);
  const row = requireDatabase()
    .prepare(
      `${ITEM_SELECT}
       WHERE i.store_id = ?
         AND i.canonical_key = ?
       ORDER BY
         CASE WHEN i.status = 'active' THEN 0 ELSE 1 END,
         i.updated_at DESC,
         i.id DESC
       LIMIT 1`,
    )
    .get(store.id, HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY) as
    | MemoryItemRow
    | undefined;
  return { store, item: row ? mapItem(row) : null };
}

function reservedRequestReplay(
  store: WorkspaceMemoryStore,
  input: {
    itemId: string;
    idempotencyKey?: string | null;
    requestHash?: string | null;
  },
): ReservedWorkspaceMemoryMutationResult | null {
  const idempotencyKey = normalizeNullable(input.idempotencyKey);
  if (!idempotencyKey) return null;
  const replay = requireDatabase()
    .prepare(
      `SELECT operation, item_id, request_hash, response_json
       FROM workspace_memory_mutation_requests
       WHERE store_id = ? AND idempotency_key = ?`,
    )
    .get(store.id, idempotencyKey) as
    | {
        operation: string;
        item_id: string;
        request_hash: string;
        response_json: string;
      }
    | undefined;
  if (!replay) return null;
  if (
    replay.operation !== 'update' ||
    replay.item_id !== input.itemId ||
    !input.requestHash ||
    replay.request_hash !== input.requestHash
  ) {
    throw new WorkspaceMemoryStoreError(
      'idempotency_conflict',
      'Idempotency key was already used for a different request',
      { storeRevision: store.revision },
    );
  }
  const response = JSON.parse(replay.response_json) as {
    store: WorkspaceMemoryStore;
    item: WorkspaceMemoryItem;
    changed?: boolean;
  };
  return {
    store: response.store,
    item: response.item,
    replayed: true,
    changed: response.changed ?? true,
  };
}

/**
 * The sole mutation primitive for the reserved preferred-address item.
 *
 * Clearing keeps the same item and monotonic revision by changing its status
 * to `superseded`; restoring changes it back to `active`. This lets callers
 * use one CAS lineage across set → update → clear → restore.
 */
export function mutateHappyClawOwnerAddressMemory(input: {
  workspaceJid: string;
  preferredAddress?: string;
  clear?: boolean;
  expectedRevision?: number;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): ReservedWorkspaceMemoryMutationResult {
  const db = requireDatabase();
  return db.transaction(() => {
    const { store: initialStore, item: current } =
      getHappyClawOwnerAddressMemoryItem(input.workspaceJid);
    const idempotencyKey = normalizeNullable(input.idempotencyKey);
    const preferredAddress = normalizeNullable(input.preferredAddress);
    if (!input.clear && !preferredAddress) {
      throw new Error('Preferred address must not be empty');
    }

    if (!current) {
      if (input.clear) {
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'HappyClaw Owner Profile revision conflict',
          { currentRevision: 0, storeRevision: initialStore.revision },
        );
      }
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== 0
      ) {
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'HappyClaw Owner Profile revision conflict',
          { currentRevision: 0, storeRevision: initialStore.revision },
        );
      }
      if (idempotencyKey) {
        const existing = db
          .prepare(
            `SELECT id, create_request_hash
             FROM workspace_memory_items
             WHERE store_id = ? AND create_idempotency_key = ?`,
          )
          .get(initialStore.id, idempotencyKey) as
          | { id: string; create_request_hash: string | null }
          | undefined;
        if (existing) {
          if (
            existing.create_request_hash &&
            input.requestHash &&
            existing.create_request_hash !== input.requestHash
          ) {
            throw new WorkspaceMemoryStoreError(
              'idempotency_conflict',
              'Idempotency key was already used for a different request',
              { storeRevision: initialStore.revision },
            );
          }
          return {
            store: requireStore(input.workspaceJid),
            item: requireItem(initialStore, existing.id),
            replayed: true,
            changed: true,
          };
        }
      }

      const at = nowIso();
      const store = bumpStore(initialStore.id, at);
      const itemId = newId('wmi');
      db.prepare(
        `INSERT INTO workspace_memory_items (
          id, store_id, workspace_jid, kind, title, content, canonical_key,
          status, importance, confidence, valid_from, valid_until, expires_at,
          revision, create_idempotency_key, create_request_hash,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, 'fact', ?, ?, ?, 'active', 1, 1,
          NULL, NULL, NULL, 1, ?, ?, ?, ?, NULL)`,
      ).run(
        itemId,
        store.id,
        store.workspaceJid,
        '主人称呼',
        preferredAddress,
        HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        idempotencyKey,
        normalizeNullable(input.requestHash),
        at,
        at,
      );
      markPlatformMemoryItem(itemId, at);
      const versionItem = requireItem(store, itemId);
      appendVersion(versionItem, 'create', input.context, at);
      const item = requireItem(store, itemId);
      replaceFts(item);
      appendAuditAndOutbox(store, item, 'create', input.context, at);
      return { store, item, replayed: false, changed: true };
    }

    if (idempotencyKey) {
      const createReplay = db
        .prepare(
          `SELECT create_request_hash
           FROM workspace_memory_items
           WHERE store_id = ? AND id = ? AND create_idempotency_key = ?`,
        )
        .get(initialStore.id, current.id, idempotencyKey) as
        | { create_request_hash: string | null }
        | undefined;
      if (createReplay) {
        if (
          createReplay.create_request_hash &&
          input.requestHash &&
          createReplay.create_request_hash !== input.requestHash
        ) {
          throw new WorkspaceMemoryStoreError(
            'idempotency_conflict',
            'Idempotency key was already used for a different request',
            { storeRevision: initialStore.revision },
          );
        }
        return {
          store: initialStore,
          item: current,
          replayed: true,
          changed: true,
        };
      }
    }

    const replay = reservedRequestReplay(initialStore, {
      itemId: current.id,
      idempotencyKey,
      requestHash: input.requestHash,
    });
    if (replay) return replay;

    if (
      input.expectedRevision === undefined ||
      input.expectedRevision !== current.revision
    ) {
      throw new WorkspaceMemoryStoreError(
        'revision_conflict',
        'HappyClaw Owner Profile revision conflict',
        {
          currentRevision: current.revision,
          storeRevision: initialStore.revision,
        },
      );
    }

    const nextStatus: WorkspaceMemoryStatus = input.clear
      ? 'superseded'
      : 'active';
    const nextContent = input.clear ? current.content : preferredAddress!;
    if (current.status === nextStatus && current.content === nextContent) {
      if (idempotencyKey && input.requestHash) {
        db.prepare(
          `INSERT INTO workspace_memory_mutation_requests (
            store_id, idempotency_key, operation, item_id, request_hash,
            response_json, created_at
          ) VALUES (?, ?, 'update', ?, ?, ?, ?)`,
        ).run(
          initialStore.id,
          idempotencyKey,
          current.id,
          input.requestHash,
          JSON.stringify({
            store: initialStore,
            item: current,
            changed: false,
          }),
          nowIso(),
        );
      }
      return {
        store: initialStore,
        item: current,
        replayed: false,
        changed: false,
      };
    }

    const at = nowIso();
    const nextRevision = current.revision + 1;
    const result = db
      .prepare(
        `UPDATE workspace_memory_items
         SET content = ?, status = ?, revision = ?, updated_at = ?,
             deleted_at = NULL
         WHERE store_id = ? AND id = ? AND revision = ?
           AND canonical_key = ?`,
      )
      .run(
        nextContent,
        nextStatus,
        nextRevision,
        at,
        initialStore.id,
        current.id,
        input.expectedRevision,
        HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      );
    if (result.changes !== 1) {
      const latest = requireItem(initialStore, current.id);
      throw new WorkspaceMemoryStoreError(
        'revision_conflict',
        'HappyClaw Owner Profile revision conflict',
        {
          currentRevision: latest.revision,
          storeRevision: requireStore(input.workspaceJid).revision,
        },
      );
    }
    const store = bumpStore(initialStore.id, at);
    if (current.status === 'deleted') {
      db.prepare(
        'DELETE FROM workspace_memory_tombstones WHERE item_id = ?',
      ).run(current.id);
    }
    const versionItem = requireItem(store, current.id);
    appendVersion(versionItem, 'update', input.context, at);
    const item = requireItem(store, current.id);
    replaceFts(item);
    appendAuditAndOutbox(store, item, 'update', input.context, at);
    if (idempotencyKey && input.requestHash) {
      db.prepare(
        `INSERT INTO workspace_memory_mutation_requests (
          store_id, idempotency_key, operation, item_id, request_hash,
          response_json, created_at
        ) VALUES (?, ?, 'update', ?, ?, ?, ?)`,
      ).run(
        store.id,
        idempotencyKey,
        item.id,
        input.requestHash,
        JSON.stringify({ store, item, changed: true }),
        at,
      );
    }
    return { store, item, replayed: false, changed: true };
  })();
}

export function createWorkspaceMemoryItem(input: {
  workspaceJid: string;
  value: WorkspaceMemoryValue;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): {
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
} {
  rejectReservedCanonicalKey(input.value.canonicalKey);
  const db = requireDatabase();
  return db.transaction(() => {
    const initialStore = requireStore(input.workspaceJid);
    const idempotencyKey = normalizeNullable(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = db
        .prepare(
          `SELECT id, create_request_hash
           FROM workspace_memory_items
           WHERE store_id = ? AND create_idempotency_key = ?`,
        )
        .get(initialStore.id, idempotencyKey) as
        | { id: string; create_request_hash: string | null }
        | undefined;
      if (existing) {
        const existingItem = requireItem(initialStore, existing.id);
        rejectReservedMemoryItem(existingItem);
        if (
          existing.create_request_hash &&
          input.requestHash &&
          existing.create_request_hash !== input.requestHash
        ) {
          throw new WorkspaceMemoryStoreError(
            'idempotency_conflict',
            'Idempotency key was already used for a different request',
            { storeRevision: initialStore.revision },
          );
        }
        return {
          store: requireStore(input.workspaceJid),
          item: existingItem,
          replayed: true,
        };
      }
    }

    const at = nowIso();
    const store = bumpStore(initialStore.id, at);
    const itemId = newId('wmi');
    db.prepare(
      `INSERT INTO workspace_memory_items (
        id, store_id, workspace_jid, kind, title, content, canonical_key,
        status, importance, confidence, valid_from, valid_until, expires_at,
        revision, create_idempotency_key, create_request_hash,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
    ).run(
      itemId,
      store.id,
      store.workspaceJid,
      input.value.kind,
      normalizeNullable(input.value.title),
      input.value.content.trim(),
      normalizeNullable(input.value.canonicalKey),
      input.value.status ?? 'active',
      input.value.importance ?? 0.5,
      input.value.confidence ?? 1,
      input.value.validFrom ?? null,
      input.value.validUntil ?? null,
      input.value.expiresAt ?? null,
      idempotencyKey,
      normalizeNullable(input.requestHash),
      at,
      at,
    );
    const versionItem = requireItem(store, itemId);
    appendVersion(versionItem, 'create', input.context, at);
    const item = requireItem(store, itemId);
    replaceFts(item);
    appendAuditAndOutbox(store, item, 'create', input.context, at);
    return { store, item, replayed: false };
  })();
}

export function updateWorkspaceMemoryItem(input: {
  workspaceJid: string;
  itemId: string;
  expectedRevision: number;
  patch: Partial<WorkspaceMemoryValue>;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): {
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
} {
  const db = requireDatabase();
  return db.transaction(() => {
    const initialStore = requireStore(input.workspaceJid);
    const current = requireItem(initialStore, input.itemId);
    rejectReservedMemoryItem(current);
    rejectReservedCanonicalKey(input.patch.canonicalKey);
    const idempotencyKey = normalizeNullable(input.idempotencyKey);
    if (idempotencyKey) {
      const replay = db
        .prepare(
          `SELECT operation, item_id, request_hash, response_json
           FROM workspace_memory_mutation_requests
           WHERE store_id = ? AND idempotency_key = ?`,
        )
        .get(initialStore.id, idempotencyKey) as
        | {
            operation: string;
            item_id: string;
            request_hash: string;
            response_json: string;
          }
        | undefined;
      if (replay) {
        if (
          replay.operation !== 'update' ||
          replay.item_id !== input.itemId ||
          !input.requestHash ||
          replay.request_hash !== input.requestHash
        ) {
          throw new WorkspaceMemoryStoreError(
            'idempotency_conflict',
            'Idempotency key was already used for a different request',
            { storeRevision: initialStore.revision },
          );
        }
        const response = JSON.parse(replay.response_json) as {
          store: WorkspaceMemoryStore;
          item: WorkspaceMemoryItem;
        };
        return { ...response, replayed: true };
      }
    }
    if (
      current.revision !== input.expectedRevision ||
      current.status === 'deleted'
    ) {
      throw new WorkspaceMemoryStoreError(
        'revision_conflict',
        'Workspace memory item revision conflict',
        {
          currentRevision: current.revision,
          storeRevision: initialStore.revision,
        },
      );
    }

    const at = nowIso();
    const nextRevision = current.revision + 1;
    const next: WorkspaceMemoryValue = {
      kind: input.patch.kind ?? current.kind,
      title:
        input.patch.title === undefined ? current.title : input.patch.title,
      content: input.patch.content ?? current.content,
      canonicalKey:
        input.patch.canonicalKey === undefined
          ? current.canonicalKey
          : input.patch.canonicalKey,
      status: input.patch.status ?? current.status,
      importance: input.patch.importance ?? current.importance,
      confidence: input.patch.confidence ?? current.confidence,
      validFrom:
        input.patch.validFrom === undefined
          ? current.validFrom
          : input.patch.validFrom,
      validUntil:
        input.patch.validUntil === undefined
          ? current.validUntil
          : input.patch.validUntil,
      expiresAt:
        input.patch.expiresAt === undefined
          ? current.expiresAt
          : input.patch.expiresAt,
    };
    const result = db
      .prepare(
        `UPDATE workspace_memory_items SET
          kind = ?, title = ?, content = ?, canonical_key = ?, status = ?,
          importance = ?, confidence = ?, valid_from = ?, valid_until = ?,
          expires_at = ?, revision = ?, updated_at = ?
         WHERE store_id = ? AND id = ? AND revision = ? AND status <> 'deleted'`,
      )
      .run(
        next.kind,
        normalizeNullable(next.title),
        next.content.trim(),
        normalizeNullable(next.canonicalKey),
        next.status ?? 'active',
        next.importance ?? 0.5,
        next.confidence ?? 1,
        next.validFrom ?? null,
        next.validUntil ?? null,
        next.expiresAt ?? null,
        nextRevision,
        at,
        initialStore.id,
        current.id,
        input.expectedRevision,
      );
    if (result.changes !== 1) {
      const latest = requireItem(initialStore, current.id);
      throw new WorkspaceMemoryStoreError(
        'revision_conflict',
        'Workspace memory item revision conflict',
        {
          currentRevision: latest.revision,
          storeRevision: requireStore(input.workspaceJid).revision,
        },
      );
    }
    const store = bumpStore(initialStore.id, at);
    const versionItem = requireItem(store, current.id);
    appendVersion(versionItem, 'update', input.context, at);
    const item = requireItem(store, current.id);
    replaceFts(item);
    appendAuditAndOutbox(store, item, 'update', input.context, at);
    if (idempotencyKey && input.requestHash) {
      db.prepare(
        `INSERT INTO workspace_memory_mutation_requests (
          store_id, idempotency_key, operation, item_id, request_hash,
          response_json, created_at
        ) VALUES (?, ?, 'update', ?, ?, ?, ?)`,
      ).run(
        store.id,
        idempotencyKey,
        item.id,
        input.requestHash,
        JSON.stringify({ store, item }),
        at,
      );
    }
    return { store, item, replayed: false };
  })();
}

export function forgetWorkspaceMemoryItem(input: {
  workspaceJid: string;
  itemId: string;
  expectedRevision: number;
  reason?: string | null;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): {
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
} {
  const db = requireDatabase();
  return db.transaction(() => {
    const initialStore = requireStore(input.workspaceJid);
    const current = requireItem(initialStore, input.itemId);
    rejectReservedMemoryItem(current);
    const idempotencyKey = normalizeNullable(input.idempotencyKey);
    if (idempotencyKey) {
      const replay = db
        .prepare(
          `SELECT operation, item_id, request_hash, response_json
           FROM workspace_memory_mutation_requests
           WHERE store_id = ? AND idempotency_key = ?`,
        )
        .get(initialStore.id, idempotencyKey) as
        | {
            operation: string;
            item_id: string;
            request_hash: string;
            response_json: string;
          }
        | undefined;
      if (replay) {
        if (
          replay.operation !== 'forget' ||
          replay.item_id !== input.itemId ||
          !input.requestHash ||
          replay.request_hash !== input.requestHash
        ) {
          throw new WorkspaceMemoryStoreError(
            'idempotency_conflict',
            'Idempotency key was already used for a different request',
            { storeRevision: initialStore.revision },
          );
        }
        const response = JSON.parse(replay.response_json) as {
          store: WorkspaceMemoryStore;
          item: WorkspaceMemoryItem;
        };
        return { ...response, replayed: true };
      }
    }
    if (
      current.revision !== input.expectedRevision ||
      current.status === 'deleted'
    ) {
      throw new WorkspaceMemoryStoreError(
        'revision_conflict',
        'Workspace memory item revision conflict',
        {
          currentRevision: current.revision,
          storeRevision: initialStore.revision,
        },
      );
    }
    const at = nowIso();
    const nextRevision = current.revision + 1;
    const result = db
      .prepare(
        `UPDATE workspace_memory_items
         SET status = 'deleted', revision = ?, updated_at = ?, deleted_at = ?
         WHERE store_id = ? AND id = ? AND revision = ? AND status <> 'deleted'`,
      )
      .run(
        nextRevision,
        at,
        at,
        initialStore.id,
        current.id,
        input.expectedRevision,
      );
    if (result.changes !== 1) {
      const latest = requireItem(initialStore, current.id);
      throw new WorkspaceMemoryStoreError(
        'revision_conflict',
        'Workspace memory item revision conflict',
        {
          currentRevision: latest.revision,
          storeRevision: requireStore(input.workspaceJid).revision,
        },
      );
    }
    const store = bumpStore(initialStore.id, at);
    const versionItem = requireItem(store, current.id);
    appendVersion(versionItem, 'forget', input.context, at);
    const item = requireItem(store, current.id);
    db.prepare(
      `INSERT INTO workspace_memory_tombstones (
        item_id, workspace_jid, deleted_revision, reason, actor_type, actor_id,
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.workspaceJid,
      item.revision,
      normalizeNullable(input.reason),
      input.context.sourceType,
      input.context.actorId,
      at,
    );
    replaceFts(item);
    appendAuditAndOutbox(store, item, 'forget', input.context, at);
    if (idempotencyKey && input.requestHash) {
      db.prepare(
        `INSERT INTO workspace_memory_mutation_requests (
          store_id, idempotency_key, operation, item_id, request_hash,
          response_json, created_at
        ) VALUES (?, ?, 'forget', ?, ?, ?, ?)`,
      ).run(
        store.id,
        idempotencyKey,
        item.id,
        input.requestHash,
        JSON.stringify({ store, item }),
        at,
      );
    }
    return { store, item, replayed: false };
  })();
}

export function listWorkspaceMemoryItems(input: {
  workspaceJid: string;
  status?: WorkspaceMemoryStatus | 'all';
  kind?: WorkspaceMemoryKind;
  query?: string;
  limit: number;
  before?: { updatedAt: string; id: string } | null;
}): { store: WorkspaceMemoryStore; items: WorkspaceMemoryItem[] } {
  const store = requireStore(input.workspaceJid);
  const clauses = [
    'i.store_id = ?',
    '(i.canonical_key IS NULL OR i.canonical_key <> ?)',
    `NOT EXISTS (
      SELECT 1 FROM workspace_memory_platform_items mpi
      WHERE mpi.item_id = i.id
    )`,
  ];
  const params: unknown[] = [
    store.id,
    HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
  ];
  if (input.status && input.status !== 'all') {
    clauses.push('i.status = ?');
    params.push(input.status);
  } else if (!input.status) {
    clauses.push('i.status = ?');
    params.push('active');
  }
  // status === 'all' includes all database-supported statuses without filtering!

  if (input.kind) {
    clauses.push('i.kind = ?');
    params.push(input.kind);
  }
  if (input.query?.trim()) {
    const query = input.query.trim();
    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    clauses.push(`(
      i.title LIKE ? ESCAPE '\\'
      OR i.content LIKE ? ESCAPE '\\'
      OR i.canonical_key LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern);
  }
  if (input.before) {
    clauses.push('(i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))');
    params.push(
      input.before.updatedAt,
      input.before.updatedAt,
      input.before.id,
    );
  }
  params.push(input.limit);
  const rows = requireDatabase()
    .prepare(
      `${ITEM_SELECT}
       WHERE ${clauses.join(' AND ')}
       ORDER BY i.updated_at DESC, i.id DESC
       LIMIT ?`,
    )
    .all(...params) as MemoryItemRow[];
  return { store, items: rows.map(mapItem) };
}

export function listRecallableWorkspaceMemoryItems(input: {
  workspaceJid: string;
  kind?: WorkspaceMemoryKind;
  limit: number;
  now?: string;
}): { store: WorkspaceMemoryStore; items: WorkspaceMemoryItem[] } {
  const store = requireStore(input.workspaceJid);
  const now = input.now ?? nowIso();
  const kindClause = input.kind ? 'AND i.kind = ?' : '';
  const params: unknown[] = [
    store.id,
    HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
    now,
    now,
    now,
    ...(input.kind ? [input.kind] : []),
    input.limit,
  ];
  const rows = requireDatabase()
    .prepare(
      `${ITEM_SELECT}
       WHERE i.store_id = ?
         AND i.status = 'active'
         AND (i.canonical_key IS NULL OR i.canonical_key <> ?)
         AND NOT EXISTS (
           SELECT 1 FROM workspace_memory_platform_items mpi
           WHERE mpi.item_id = i.id
         )
         AND (i.valid_from IS NULL OR julianday(i.valid_from) <= julianday(?))
         AND (i.valid_until IS NULL OR julianday(i.valid_until) > julianday(?))
         AND (i.expires_at IS NULL OR julianday(i.expires_at) > julianday(?))
         ${kindClause}
       ORDER BY i.importance DESC, i.updated_at DESC, i.id DESC
       LIMIT ?`,
    )
    .all(...params) as MemoryItemRow[];
  return { store, items: rows.map(mapItem) };
}

function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

export function searchWorkspaceMemoryItems(input: {
  workspaceJid: string;
  query: string;
  kind?: WorkspaceMemoryKind;
  status?: WorkspaceMemoryStatus | 'all';
  scope?: 'manage' | 'recall';
  limit: number;
  before?: { updatedAt: string; id: string } | null;
  now?: string;
}): {
  store: WorkspaceMemoryStore;
  hits: Array<{ item: WorkspaceMemoryItem; rank: number; snippet: string }>;
} {
  const db = requireDatabase();
  const store = requireStore(input.workspaceJid);
  const now = input.now ?? nowIso();
  const query = input.query.trim();
  const isManage = input.scope === 'manage';

  if (isManage) {
    const clauses = [
      'i.store_id = ?',
      '(i.canonical_key IS NULL OR i.canonical_key <> ?)',
      `NOT EXISTS (
        SELECT 1 FROM workspace_memory_platform_items mpi
        WHERE mpi.item_id = i.id
      )`,
    ];
    const params: unknown[] = [
      store.id,
      HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
    ];

    if (input.status && input.status !== 'all') {
      clauses.push('i.status = ?');
      params.push(input.status);
    }
    // all or omitted in manage mode includes all database-supported statuses!

    if (input.kind) {
      clauses.push('i.kind = ?');
      params.push(input.kind);
    }

    if (input.before) {
      clauses.push('(i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))');
      params.push(
        input.before.updatedAt,
        input.before.updatedAt,
        input.before.id,
      );
    }

    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    clauses.push(`(
      i.title LIKE ? ESCAPE '\\'
      OR i.content LIKE ? ESCAPE '\\'
      OR i.canonical_key LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern);
    params.push(input.limit);

    const rows = db
      .prepare(
        `SELECT i.*, p.source_type, p.source_id, p.session_id, p.observed_at,
          0 AS search_rank,
          substr(i.content, 1, 240) AS search_snippet
         FROM workspace_memory_items i
         LEFT JOIN workspace_memory_provenance p
           ON p.item_id = i.id AND p.revision = i.revision
         WHERE ${clauses.join(' AND ')}
         ORDER BY i.updated_at DESC, i.id DESC
         LIMIT ?`,
      )
      .all(...params) as Array<
      MemoryItemRow & { search_rank: number; search_snippet: string }
    >;

    return {
      store,
      hits: rows.map((row) => ({
        item: mapItem(row),
        rank: Number(row.search_rank),
        snippet: row.search_snippet || row.content.slice(0, 240),
      })),
    };
  }

  // Recall scope (Agent runtime) - KEEP 100% UNTOUCHED
  const kindClause = input.kind ? 'AND i.kind = ?' : '';
  const beforeClause = input.before
    ? 'AND (i.updated_at < ? OR (i.updated_at = ? AND i.id < ?))'
    : '';
  const beforeParams = input.before
    ? [input.before.updatedAt, input.before.updatedAt, input.before.id]
    : [];
  const params: unknown[] = [
    store.id,
    HAPPYCLAW_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
    now,
    now,
    now,
    ...(input.kind ? [input.kind] : []),
  ];

  let rows: Array<
    MemoryItemRow & { search_rank: number; search_snippet: string }
  >;
  if ([...query].length >= 3) {
    rows = db
      .prepare(
        `SELECT i.*, p.source_type, p.source_id, p.session_id, p.observed_at,
          bm25(workspace_memory_fts, 0, 0, 3, 1, 2) AS search_rank,
          snippet(workspace_memory_fts, 3, '‹', '›', '…', 24) AS search_snippet
         FROM workspace_memory_fts
         JOIN workspace_memory_items i
           ON i.id = workspace_memory_fts.item_id
         LEFT JOIN workspace_memory_provenance p
           ON p.item_id = i.id AND p.revision = i.revision
         WHERE i.store_id = ?
           AND i.status = 'active'
           AND (i.canonical_key IS NULL OR i.canonical_key <> ?)
           AND NOT EXISTS (
             SELECT 1 FROM workspace_memory_platform_items mpi
             WHERE mpi.item_id = i.id
           )
           AND (i.valid_from IS NULL OR julianday(i.valid_from) <= julianday(?))
           AND (i.valid_until IS NULL OR julianday(i.valid_until) > julianday(?))
           AND (i.expires_at IS NULL OR julianday(i.expires_at) > julianday(?))
           ${kindClause}
           ${beforeClause}
           AND workspace_memory_fts MATCH ?
         ORDER BY search_rank ASC, i.importance DESC, i.updated_at DESC
         LIMIT ?`,
      )
      .all(...params, ...beforeParams, ftsPhrase(query), input.limit) as Array<
      MemoryItemRow & { search_rank: number; search_snippet: string }
    >;
  } else {
    const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    rows = db
      .prepare(
        `SELECT i.*, p.source_type, p.source_id, p.session_id, p.observed_at,
          0 AS search_rank,
          substr(i.content, 1, 240) AS search_snippet
         FROM workspace_memory_items i
         LEFT JOIN workspace_memory_provenance p
           ON p.item_id = i.id AND p.revision = i.revision
         WHERE i.store_id = ?
           AND i.status = 'active'
           AND (i.canonical_key IS NULL OR i.canonical_key <> ?)
           AND NOT EXISTS (
             SELECT 1 FROM workspace_memory_platform_items mpi
             WHERE mpi.item_id = i.id
           )
           AND (i.valid_from IS NULL OR julianday(i.valid_from) <= julianday(?))
           AND (i.valid_until IS NULL OR julianday(i.valid_until) > julianday(?))
           AND (i.expires_at IS NULL OR julianday(i.expires_at) > julianday(?))
           ${kindClause}
           ${beforeClause}
           AND (
             i.title LIKE ? ESCAPE '\\'
             OR i.content LIKE ? ESCAPE '\\'
             OR i.canonical_key LIKE ? ESCAPE '\\'
           )
         ORDER BY i.importance DESC, i.updated_at DESC
         LIMIT ?`,
      )
      .all(
        ...params,
        ...beforeParams,
        pattern,
        pattern,
        pattern,
        input.limit,
      ) as Array<
      MemoryItemRow & { search_rank: number; search_snippet: string }
    >;
  }
  return {
    store,
    hits: rows.map((row) => ({
      item: mapItem(row),
      rank: Number(row.search_rank),
      snippet: row.search_snippet || row.content.slice(0, 240),
    })),
  };
}

export function listWorkspaceMemoryVersions(input: {
  workspaceJid: string;
  itemId: string;
  limit: number;
  beforeRevision?: number | null;
}): {
  store: WorkspaceMemoryStore;
  itemId: string;
  versions: WorkspaceMemoryVersion[];
} {
  const store = requireStore(input.workspaceJid);
  const item = requireItem(store, input.itemId);
  if (isReservedMemoryItem(item)) {
    throw new WorkspaceMemoryStoreError(
      'item_not_found',
      'Workspace memory item not found',
    );
  }
  const clauses = ['v.item_id = ?'];
  const params: unknown[] = [input.itemId];
  if (input.beforeRevision) {
    clauses.push('v.revision < ?');
    params.push(input.beforeRevision);
  }
  params.push(input.limit);
  const rows = requireDatabase()
    .prepare(
      `SELECT
        v.item_id AS id, v.workspace_jid, v.kind, v.title, v.content,
        v.canonical_key, v.status, v.importance, v.confidence, v.valid_from,
        v.valid_until, v.expires_at, v.revision, v.created_at,
        v.created_at AS updated_at, NULL AS deleted_at, v.change_type,
        v.actor_type, v.actor_id,
        p.source_type, p.source_id, p.session_id, p.observed_at
       FROM workspace_memory_versions v
       LEFT JOIN workspace_memory_provenance p
         ON p.item_id = v.item_id AND p.revision = v.revision
       WHERE ${clauses.join(' AND ')}
       ORDER BY v.revision DESC
       LIMIT ?`,
    )
    .all(...params) as MemoryVersionRow[];
  return {
    store,
    itemId: input.itemId,
    versions: rows.map(mapVersion),
  };
}
