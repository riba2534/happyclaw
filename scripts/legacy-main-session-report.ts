/**
 * Rehearse the v88 migration (main sessions become ordinary sessions) on a
 * copy of a database and report what it did.
 *
 * Run from a repository checkout whose data/db/messages.db is the copy:
 *   npx tsx scripts/legacy-main-session-report.ts [--no-fs]
 *
 * The copy is migrated in place (it ends at v88) without a pre-migration
 * backup and with logging off. Session directories are never moved: the
 * planned moves are listed, and --no-fs lists them without looking at the
 * disk. Prints one JSON document and exits 1 when an invariant check fails.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

function countMessages(conn: Database.Database): number {
  return (
    conn.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  ).n;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--no-fs');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown.join(' ')}`);
  }
  const inspectFs = !args.includes('--no-fs');

  const checkout = fs.realpathSync(process.cwd());
  const dataDir = path.join(checkout, 'data');
  const dbPath = path.join(dataDir, 'db', 'messages.db');
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  // A data/ symlinked to a live installation would migrate that one instead.
  if (!fs.realpathSync(dbPath).startsWith(checkout + path.sep)) {
    throw new Error(`Refusing: ${dbPath} resolves outside ${checkout}`);
  }

  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  const schemaVersionBefore =
    (
      source
        .prepare("SELECT value FROM router_state WHERE key = 'schema_version'")
        .get() as { value: string } | undefined
    )?.value ?? null;
  const messagesBefore = countMessages(source);
  source.close();

  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  // The logger writes to stdout, which carries the JSON; the report has it all.
  process.env.LOG_LEVEL = 'silent';
  const db = await import('../src/db.js');
  const migration = await import('../src/legacy-main-session-migration.js');
  const report = db.initDatabase({
    relocateLegacySessionDirectories: false,
  }).legacyMainSessions;
  db.closeDatabase();

  const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const directories = migration.relocateLegacyMainSessionDirectories(conn, {
      dataDir,
      dryRun: true,
      inspect: inspectFs,
    });
    const checks = migration.checkLegacyMainSessionInvariants(conn, {
      expectedSchemaVersion: db.CURRENT_SCHEMA_VERSION,
      messagesBefore: report ? messagesBefore : undefined,
      report,
    });
    const ok = checks.every((check) => check.ok);
    const workspaces = report?.workspaces ?? [];
    const output = {
      ok,
      database: dbPath,
      schemaVersionBefore,
      migrated: !!report,
      messagesBefore,
      messagesAfter: countMessages(conn),
      summary: report && {
        sessionsCreated: workspaces.filter((w) => !w.reused).length,
        messagesMoved: workspaces.reduce((n, w) => n + w.messagesMoved, 0),
        duplicatesRemoved: report.duplicatesRemoved,
        bindingsRebound: workspaces.reduce((n, w) => n + w.bindings.length, 0),
        automationsRetargeted: workspaces.reduce(
          (n, w) => n + w.automations.length,
          0,
        ),
        sdkSessionsMoved: workspaces.filter((w) => w.sdkSession).length,
        modelSelectionsMoved: workspaces.filter((w) => w.modelSelection).length,
        pendingInputs: report.pendingMessageIds.length,
      },
      ...report,
      directories,
      checks,
    };
    console.log(JSON.stringify(output, null, 2));
    return ok ? 0 : 1;
  } finally {
    conn.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
