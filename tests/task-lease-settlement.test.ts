import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lease-settlement-'));
const tmpStoreDir = path.join(tmpDir, 'db');
fs.mkdirSync(tmpStoreDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function createDefinition(id: string) {
  db.createTask({
    id,
    group_folder: 'workspace',
    chat_jid: 'web:workspace',
    prompt: 'report status',
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() - 1_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: ['feishu'],
  } as Parameters<typeof db.createTask>[0]);
  return db.getTaskById(id)!;
}

/** Claim a fresh run with a lease that is already expired on arrival. */
function claimWithExpiredLease(owner: string) {
  const task = createDefinition(`lease-task-${++seq}`);
  db.createTaskRun({
    task,
    triggerType: 'manual',
    idempotencyKey: `key-${seq}`,
  });
  // Negative lease => lease_expires_at is in the past the moment we hold it.
  const claim = db.claimNextTaskRun(owner, -1_000);
  expect(claim).toBeDefined();
  return claim!;
}

describe('lease expiry decides takeover, not settlement', () => {
  test('an expired but unclaimed lease can still commit its terminal state', () => {
    // The regression: a run that actually finished — possibly after already
    // sending output to the user — could not be committed once its lease
    // lapsed, stayed `running`, and was later marked `failed`. Because started
    // runs are at-most-once, that silently lost a successful execution.
    const claim = claimWithExpiredLease('owner-a');
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
        result: 'done',
      }),
    ).toBe(true);
    expect(db.getTaskRunById(claim.id)?.status).toBe('success');
  });

  test('an expired but unclaimed lease can still renew and release', () => {
    const renewClaim = claimWithExpiredLease('owner-a');
    expect(
      db.renewTaskRunLease(
        renewClaim.id,
        renewClaim.lease_owner,
        renewClaim.lease_token,
        60_000,
      ),
    ).toBe(true);

    const releaseClaim = claimWithExpiredLease('owner-a');
    expect(
      db.releaseTaskRunForRetry(
        releaseClaim.id,
        releaseClaim.lease_owner,
        releaseClaim.lease_token,
        new Date(Date.now() + 1_000).toISOString(),
        'transient',
      ),
    ).toBe(true);
    expect(db.getTaskRunById(releaseClaim.id)?.status).toBe('retry_wait');
  });

  test('once another owner takes over, the old worker is fenced out', () => {
    const first = claimWithExpiredLease('owner-a');
    const second = db.claimNextTaskRun('owner-b', 60_000);
    expect(second?.id).toBe(first.id);
    expect(second!.lease_token).toBeGreaterThan(first.lease_token);

    expect(
      db.completeTaskRun(first.id, first.lease_owner, first.lease_token, {
        status: 'success',
      }),
    ).toBe(false);
    expect(
      db.renewTaskRunLease(
        first.id,
        first.lease_owner,
        first.lease_token,
        60_000,
      ),
    ).toBe(false);
    expect(db.getTaskRunById(first.id)?.status).toBe('running');

    // The new owner still settles normally.
    expect(
      db.completeTaskRun(second!.id, second!.lease_owner, second!.lease_token, {
        status: 'success',
      }),
    ).toBe(true);
  });
});

describe('attempt accounting', () => {
  test('a non-attributable release returns the claim budget', () => {
    // Shutdown must not burn the pre-execution retry allowance: five ordinary
    // restarts previously failed an occurrence that never executed once.
    const task = createDefinition('attempt-shutdown');
    db.createTaskRun({
      task,
      triggerType: 'scheduled',
      idempotencyKey: 'attempt-shutdown-key',
    });

    const first = db.claimNextTaskRun('owner-a', 60_000)!;
    expect(first.attempt).toBe(1);
    db.releaseTaskRunForRetry(
      first.id,
      first.lease_owner,
      first.lease_token,
      new Date(Date.now() - 1_000).toISOString(),
      'Process shut down before the run started',
      { countsAsAttempt: false },
    );
    expect(db.getTaskRunById(first.id)?.attempt).toBe(0);

    const second = db.claimNextTaskRun('owner-a', 60_000)!;
    expect(second.attempt).toBe(1);
  });

  test('an attributable release keeps the attempt spent', () => {
    const task = createDefinition('attempt-real-failure');
    db.createTaskRun({
      task,
      triggerType: 'scheduled',
      idempotencyKey: 'attempt-real-failure-key',
    });

    const first = db.claimNextTaskRun('owner-a', 60_000)!;
    expect(first.attempt).toBe(1);
    db.releaseTaskRunForRetry(
      first.id,
      first.lease_owner,
      first.lease_token,
      new Date(Date.now() - 1_000).toISOString(),
      'Task queue dropped the run',
    );
    expect(db.getTaskRunById(first.id)?.attempt).toBe(1);

    const second = db.claimNextTaskRun('owner-a', 60_000)!;
    expect(second.attempt).toBe(2);
  });
});
