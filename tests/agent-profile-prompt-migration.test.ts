import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-prompt-v48-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

beforeAll(() => {
  const legacy = new Database(path.join(tmpStoreDir, 'messages.db'));
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_state (key, value) VALUES ('schema_version', '47');
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      include_claude_preset INTEGER NOT NULL DEFAULT 1,
      avatar_emoji TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      runtime_policy TEXT NOT NULL DEFAULT '{}',
      identity_hash TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO agent_profiles VALUES (
      'legacy-profile', 'legacy-owner', 'Legacy', '  old prompt\n', 0,
      NULL, NULL, NULL, '{}', 'old-hash', 7, 0, 'active',
      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
    );
  `);
  legacy.close();
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('AgentProfile v48 prompt migration', () => {
  test('moves the old prompt to AGENTS without data loss and snapshots it', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();
    const profile = db.getAgentProfile('legacy-profile');
    expect(profile).toMatchObject({
      identity_prompt: '',
      soul_prompt: '',
      agents_prompt: '  old prompt\n',
      tools_prompt: '',
      prompt_mode: 'replace',
      include_claude_preset: false,
      version: 7,
    });

    const raw = new Database(path.join(tmpStoreDir, 'messages.db'));
    const history = raw
      .prepare(
        'SELECT version, agents_prompt, prompt_mode, change_source FROM agent_profile_prompt_versions WHERE agent_profile_id = ?',
      )
      .get('legacy-profile');
    expect(history).toEqual({
      version: 7,
      agents_prompt: '  old prompt\n',
      prompt_mode: 'replace',
      change_source: 'migration',
    });
    expect(
      raw
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .get(),
      // Prompt migration remains v48, while the database may continue through
      // later additive migrations in the same startup (v49 channel accounts,
      // then the v60 durable channel reliability ledgers and v61 interaction mode).
    ).toEqual({ value: String(db.CURRENT_SCHEMA_VERSION) });
    raw.close();
  });
});
