import type Database from 'better-sqlite3';

export interface CapabilityMutationRecord {
  requestId: string;
  userId: string;
  sourceGroup?: string | null;
  groupFolder?: string | null;
  sessionId?: string | null;
  inputTurnId?: string | null;
  capabilityKind: 'skills';
  action: 'install' | 'uninstall';
  target: string;
  status:
    | 'pending'
    | 'accepted'
    | 'applying'
    | 'applied'
    | 'failed'
    | 'quiesce_failed';
  claimOwner?: string | null;
  claimExpiresAt?: string | null;
  resultJson?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string | null;
}

let activeMutationDatabase: Database.Database | null = null;

export function bindCapabilityMutationDatabase(
  db: Database.Database | null,
): void {
  activeMutationDatabase = db;
}

function requireDatabase(): Database.Database {
  if (!activeMutationDatabase) {
    throw new Error('Capability mutation database is not initialized');
  }
  return activeMutationDatabase;
}

export function createCapabilityMutationSchema(
  connection: Database.Database,
): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS capability_mutation_requests (
      request_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_group TEXT,
      group_folder TEXT,
      session_id TEXT,
      input_turn_id TEXT,
      capability_kind TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      claim_owner TEXT,
      claim_expires_at TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cap_mutation_scope
      ON capability_mutation_requests(group_folder, session_id, input_turn_id, status);
  `);
}

function mapMutationRow(row: any): CapabilityMutationRecord {
  return {
    requestId: row.request_id,
    userId: row.user_id,
    sourceGroup: row.source_group ?? null,
    groupFolder: row.group_folder ?? null,
    sessionId: row.session_id ?? null,
    inputTurnId: row.input_turn_id ?? null,
    capabilityKind: row.capability_kind,
    action: row.action,
    target: row.target,
    status: row.status,
    claimOwner: row.claim_owner ?? null,
    claimExpiresAt: row.claim_expires_at ?? null,
    resultJson: row.result_json ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? null,
  };
}

export function getCapabilityMutationRequest(
  requestId: string,
): CapabilityMutationRecord | undefined {
  const db = requireDatabase();
  const row = db
    .prepare('SELECT * FROM capability_mutation_requests WHERE request_id = ?')
    .get(requestId);
  return row ? mapMutationRow(row) : undefined;
}

export function recordCapabilityMutationRequest(
  record: Omit<CapabilityMutationRecord, 'createdAt' | 'updatedAt'>,
): CapabilityMutationRecord {
  const db = requireDatabase();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT * FROM capability_mutation_requests WHERE request_id = ?',
      )
      .get(record.requestId);
    if (existing) {
      const mapped = mapMutationRow(existing);
      if (
        mapped.userId !== record.userId ||
        mapped.action !== record.action ||
        mapped.target !== record.target
      ) {
        throw new Error(
          `Request ID conflict: requestId "${record.requestId}" already exists with different operation or user identity`,
        );
      }
      return mapped;
    }
    db.prepare(
      `INSERT INTO capability_mutation_requests (
        request_id, user_id, source_group, group_folder, session_id, input_turn_id,
        capability_kind, action, target, status, claim_owner, claim_expires_at,
        result_json, error, created_at, updated_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.requestId,
      record.userId,
      record.sourceGroup ?? null,
      record.groupFolder ?? null,
      record.sessionId ?? null,
      record.inputTurnId ?? null,
      record.capabilityKind,
      record.action,
      record.target,
      record.status,
      record.claimOwner ?? null,
      record.claimExpiresAt ?? null,
      record.resultJson ?? null,
      record.error ?? null,
      now,
      now,
      record.appliedAt ?? null,
    );
    return {
      ...record,
      createdAt: now,
      updatedAt: now,
    };
  })();
}

export function claimCapabilityMutation(
  requestId: string,
  owner: string,
  leaseMs = 60_000,
): CapabilityMutationRecord | undefined {
  const db = requireDatabase();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();

  return db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE capability_mutation_requests
         SET status = 'applying', claim_owner = ?, claim_expires_at = ?, updated_at = ?
         WHERE request_id = ?
           AND (
             status IN ('accepted', 'pending', 'quiesce_failed')
             OR (status = 'applying' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
           )`,
      )
      .run(owner, expiresAt, now, requestId, now);

    if (res.changes !== 1) return undefined;
    return getCapabilityMutationRequest(requestId);
  })();
}

export function updateCapabilityMutationRequest(
  requestId: string,
  update: {
    status:
      | 'pending'
      | 'accepted'
      | 'applying'
      | 'applied'
      | 'failed'
      | 'quiesce_failed';
    expectedClaimOwner?: string;
    resultJson?: string | null;
    error?: string | null;
    appliedAt?: string | null;
  },
): boolean {
  const db = requireDatabase();
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `UPDATE capability_mutation_requests
       SET status = ?,
           claim_owner = NULL,
           claim_expires_at = NULL,
           result_json = COALESCE(?, result_json),
           error = COALESCE(?, error),
           applied_at = COALESCE(?, applied_at),
           updated_at = ?
       WHERE request_id = ?
         AND (? IS NULL OR (claim_owner = ? AND status = 'applying'))`,
    )
    .run(
      update.status,
      update.resultJson ?? null,
      update.error ?? null,
      update.appliedAt ?? (update.status === 'applied' ? now : null),
      now,
      requestId,
      update.expectedClaimOwner ?? null,
      update.expectedClaimOwner ?? null,
    );
  return res.changes === 1;
}

export function listPendingCapabilityMutations(filter?: {
  groupFolder?: string;
  sessionId?: string;
  inputTurnId?: string;
  userId?: string;
  now?: string;
}): CapabilityMutationRecord[] {
  const db = requireDatabase();
  const now = filter?.now ?? new Date().toISOString();
  let query = `SELECT * FROM capability_mutation_requests
     WHERE (
       status IN ('pending', 'accepted', 'quiesce_failed')
       OR (status = 'applying' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
     )`;
  const params: any[] = [now];
  if (filter?.groupFolder) {
    query += ' AND group_folder = ?';
    params.push(filter.groupFolder);
  }
  if (filter?.sessionId) {
    query += ' AND (session_id IS NULL OR session_id = ?)';
    params.push(filter.sessionId);
  }
  if (filter?.inputTurnId) {
    query += ' AND (input_turn_id IS NULL OR input_turn_id = ?)';
    params.push(filter.inputTurnId);
  }
  if (filter?.userId) {
    query += ' AND user_id = ?';
    params.push(filter.userId);
  }
  query += ' ORDER BY created_at ASC';
  const rows = db.prepare(query).all(...params);
  return rows.map(mapMutationRow);
}
