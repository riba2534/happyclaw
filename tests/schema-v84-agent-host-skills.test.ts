import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v84-agent-host-skills-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const backupDir = path.join(root, 'backups');
const databasePath = path.join(storeDir, 'messages.db');
for (const dir of [storeDir, groupsDir, dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { formerMainSession } = await import('./helpers/legacy-main-session.js');
// Loading the runtime module registers the main HappyClaw settings reader,
// as the server does before it initializes the database.
const runtime = await import('../src/agent-profile-runtime.js');
const runtimeConfig = await import('../src/runtime-config.js');

type Policy = ReturnType<typeof db.normalizeAgentProfileRuntimePolicy>;

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

function createUser(
  id: string,
  role: 'admin' | 'member',
  status: 'active' | 'disabled' = 'active',
): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status,
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

/** The identity a v83 runner recorded for a profile without `skills.host`. */
function legacyEffectiveHash(
  profile: ReturnType<typeof db.getAgentProfile> & object,
  legacyPolicy: Policy,
  effectiveSource: 'managed' | 'host_claude',
): string {
  const hash = db.computeAgentProfileIdentityHash(
    profile,
    {
      ...legacyPolicy,
      context: { ...legacyPolicy.context, source: effectiveSource },
    },
    profile.name,
  );
  return profile.is_default
    ? runtime.bindHappyClawPlatformIdentityHash(hash)
    : hash;
}

interface LegacyCase {
  id: string;
  folder: string;
  effectiveSource: 'managed' | 'host_claude';
  legacyHash: string;
  version: number;
}

/**
 * Build a current database with profiles and live SDK sessions, then rewind
 * it on disk to the v83 shape: no `skills.host`, sessions recorded under the
 * identity hash the v83 runner computed.
 */
function buildV83Database(
  profiles: Array<{
    folder: string;
    owner: string;
    effectiveSource: 'managed' | 'host_claude';
    create: () => ReturnType<typeof db.createAgentProfile>;
    /** Store unreadable JSON, as a hand-edited or truncated row would. */
    corruptPolicy?: boolean;
  }>,
): LegacyCase[] {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  for (const file of fs.readdirSync(storeDir)) {
    fs.rmSync(path.join(storeDir, file), { force: true });
  }
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  createUser('admin-owner', 'admin');
  createUser('member-owner', 'member');
  createUser('disabled-admin', 'admin', 'disabled');

  const created = profiles.map((entry) => {
    const profile = entry.create();
    const jid = `web:${entry.folder}`;
    db.setRegisteredGroup(jid, {
      name: entry.folder,
      folder: entry.folder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: entry.owner,
    });
    db.assignWorkspaceAgentProfile(entry.folder, profile.id);
    db.setSession(entry.folder, `sdk-${entry.folder}`, null, {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: 'placeholder',
    });
    return { entry, profile };
  });
  db.closeDatabase();

  const legacy = new Database(databasePath);
  const cases = created.map(({ entry, profile }) => {
    const raw = JSON.parse(
      (
        legacy
          .prepare('SELECT runtime_policy FROM agent_profiles WHERE id = ?')
          .get(profile.id) as { runtime_policy: string }
      ).runtime_policy,
    );
    delete raw.skills.host;
    // The runner decodes unreadable JSON to the default policy.
    const legacyPolicy = db.normalizeAgentProfileRuntimePolicy(
      entry.corruptPolicy ? undefined : raw,
    );
    const legacyHash = legacyEffectiveHash(
      profile,
      legacyPolicy,
      entry.effectiveSource,
    );
    legacy
      .prepare(
        'UPDATE agent_profiles SET runtime_policy = ?, identity_hash = ? WHERE id = ?',
      )
      .run(
        entry.corruptPolicy ? '{"skills": {"mode": ' : JSON.stringify(raw),
        db.computeAgentProfileIdentityHash(profile, legacyPolicy, profile.name),
        profile.id,
      );
    legacy
      .prepare('UPDATE sessions SET identity_hash = ? WHERE group_folder = ?')
      .run(legacyHash, entry.folder);
    legacy
      .prepare(
        'UPDATE workspace_runtime_sessions SET identity_hash = ? WHERE group_folder = ?',
      )
      .run(legacyHash, entry.folder);
    return {
      id: profile.id,
      folder: entry.folder,
      effectiveSource: entry.effectiveSource,
      legacyHash,
      version: profile.version,
    };
  });
  legacy
    .prepare(
      "UPDATE router_state SET value = '83' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
  return cases;
}

function upgrade(): void {
  process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
  db.initDatabase();
  expect(db.getRouterState('schema_version')).toBe(
    String(db.CURRENT_SCHEMA_VERSION),
  );
}

/** The upgrade changed no run: same revision, same effective identity. */
function expectSessionKept(entry: LegacyCase): void {
  const profile = db.getAgentProfile(entry.id)!;
  expect(profile.version).toBe(entry.version);
  const effective = runtime.resolveEffectiveAgentProfile(profile)!;
  expect(effective.runtime_policy.context.source).toBe(entry.effectiveSource);
  // v88 moved the main session's SDK row onto its own session.
  const sessionId = formerMainSession(db, `web:${entry.folder}`).id;
  const session = db.getSessionAgentIdentity(entry.folder, sessionId)!;
  expect(session.identity_hash).toBe(effective.identity_hash);
  expect(session.agent_profile_version).toBe(profile.version);
  expect(
    db.getWorkspaceRuntimeSession(entry.folder, sessionId)?.identity_hash,
  ).toBe(effective.identity_hash);
  // The persisted hash follows the pinned policy, so a later cosmetic edit
  // is not mistaken for an identity change.
  expect(profile.identity_hash).toBe(
    db.computeAgentProfileIdentityHash(
      profile,
      profile.runtime_policy,
      profile.name,
    ),
  );
}

function hostSkills(entry: LegacyCase) {
  return db.getAgentProfile(entry.id)!.runtime_policy.skills.host;
}

describe('schema v84 pins host Skill policies', () => {
  test('system host_claude: admin main HappyClaw and host-context Agents keep every host Skill', () => {
    runtimeConfig.saveSystemSettings({ mainAgentContextSource: 'host_claude' });
    const [adminMain, adminHost, adminManaged, memberMain, memberHost] =
      buildV83Database([
        {
          folder: 'admin-main',
          owner: 'admin-owner',
          effectiveSource: 'host_claude',
          create: () => db.getOrCreateDefaultAgentProfile('admin-owner'),
        },
        {
          folder: 'admin-host',
          owner: 'admin-owner',
          effectiveSource: 'host_claude',
          create: () =>
            db.createAgentProfile({
              ownerUserId: 'admin-owner',
              name: 'Host Context',
              agentsPrompt: 'Review code.',
              runtimePolicy: { context: { source: 'host_claude' } },
            }),
        },
        {
          folder: 'admin-managed',
          owner: 'admin-owner',
          effectiveSource: 'managed',
          create: () =>
            db.createAgentProfile({
              ownerUserId: 'admin-owner',
              name: 'Managed',
              runtimePolicy: { skills: { mode: 'custom', ids: ['research'] } },
            }),
        },
        {
          folder: 'member-main',
          owner: 'member-owner',
          effectiveSource: 'managed',
          create: () => db.getOrCreateDefaultAgentProfile('member-owner'),
        },
        {
          // Saved while its owner was an admin; the owner is a member now.
          folder: 'member-host',
          owner: 'member-owner',
          effectiveSource: 'managed',
          create: () =>
            db.createAgentProfile({
              ownerUserId: 'member-owner',
              name: 'Downgraded',
              runtimePolicy: { context: { source: 'host_claude' } },
            }),
        },
      ]);
    upgrade();

    expect(hostSkills(adminMain)).toEqual({ mode: 'inherit', ids: [] });
    expect(hostSkills(adminHost)).toEqual({ mode: 'inherit', ids: [] });
    expect(hostSkills(adminManaged)).toEqual({ mode: 'disabled', ids: [] });
    expect(hostSkills(memberMain)).toEqual({ mode: 'disabled', ids: [] });
    expect(hostSkills(memberHost)).toEqual({ mode: 'disabled', ids: [] });
    // The custom selection and the persisted context source stay as saved.
    expect(db.getAgentProfile(adminManaged.id)!.runtime_policy.skills).toEqual({
      mode: 'custom',
      ids: ['research'],
      host: { mode: 'disabled', ids: [] },
    });
    expect(
      db.getAgentProfile(memberHost.id)!.runtime_policy.context.source,
    ).toBe('host_claude');

    for (const entry of [
      adminMain,
      adminHost,
      adminManaged,
      memberMain,
      memberHost,
    ]) {
      expectSessionKept(entry);
    }
    // A cosmetic edit after the upgrade does not restart the conversation.
    const touched = db.updateAgentProfile(adminHost.id, 'admin-owner', {
      avatarEmoji: '🦀',
    })!;
    expect(touched.version).toBe(adminHost.version);

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v83-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      const saved = backup
        .prepare('SELECT runtime_policy FROM agent_profiles WHERE id = ?')
        .get(adminMain.id) as { runtime_policy: string };
      expect(JSON.parse(saved.runtime_policy).skills).not.toHaveProperty(
        'host',
      );
    } finally {
      backup.close();
    }
  });

  test('system managed: the admin main HappyClaw keeps host Skills off', () => {
    runtimeConfig.saveSystemSettings({ mainAgentContextSource: 'managed' });
    const [adminMain] = buildV83Database([
      {
        folder: 'admin-main-managed',
        owner: 'admin-owner',
        effectiveSource: 'managed',
        create: () => db.getOrCreateDefaultAgentProfile('admin-owner'),
      },
    ]);
    upgrade();

    expect(hostSkills(adminMain)).toEqual({ mode: 'disabled', ids: [] });
    expectSessionKept(adminMain);

    // Switching the system setting later no longer moves host Skills along.
    runtimeConfig.saveSystemSettings({ mainAgentContextSource: 'host_claude' });
    db.closeDatabase();
    upgrade();
    expect(hostSkills(adminMain)).toEqual({ mode: 'disabled', ids: [] });
  });

  test('a disabled admin and an unreadable policy pin host Skills off', () => {
    runtimeConfig.saveSystemSettings({ mainAgentContextSource: 'host_claude' });
    const [disabledMain, disabledHost, corrupt] = buildV83Database([
      {
        folder: 'disabled-main',
        owner: 'disabled-admin',
        effectiveSource: 'managed',
        create: () => db.getOrCreateDefaultAgentProfile('disabled-admin'),
      },
      {
        folder: 'disabled-host',
        owner: 'disabled-admin',
        effectiveSource: 'managed',
        create: () =>
          db.createAgentProfile({
            ownerUserId: 'disabled-admin',
            name: 'Disabled Host',
            runtimePolicy: { context: { source: 'host_claude' } },
          }),
      },
      {
        folder: 'corrupt-policy',
        owner: 'admin-owner',
        effectiveSource: 'managed',
        corruptPolicy: true,
        create: () =>
          db.createAgentProfile({
            ownerUserId: 'admin-owner',
            name: 'Corrupt Policy',
            runtimePolicy: {
              context: { source: 'host_claude' },
              skills: { mode: 'custom', ids: ['lost'] },
            },
          }),
      },
    ]);
    upgrade();

    expect(hostSkills(disabledMain)).toEqual({ mode: 'disabled', ids: [] });
    expect(hostSkills(disabledHost)).toEqual({ mode: 'disabled', ids: [] });
    // Unreadable JSON becomes the default policy the runner already used,
    // now with an explicit grant.
    expect(db.getAgentProfile(corrupt.id)!.runtime_policy).toEqual({
      ...db.normalizeAgentProfileRuntimePolicy(),
      skills: { mode: 'inherit', ids: [], host: { mode: 'disabled', ids: [] } },
    });
    for (const entry of [disabledMain, disabledHost, corrupt]) {
      expectSessionKept(entry);
    }
  });
});
