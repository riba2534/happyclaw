/**
 * The v88 migration (main sessions become ordinary sessions): rehearse it on
 * a copy, or check a live database after it.
 *
 * Rehearse, from a repository checkout whose data/db/messages.db is a copy:
 *   npx tsx scripts/legacy-main-session-report.ts [--no-fs]
 * The copy is migrated in place (it ends at v88) without a pre-migration
 * backup and with logging off. Session directories are never moved: the
 * planned moves are listed, and --no-fs lists them without looking at the
 * disk.
 *
 * Check, read-only, next to a running server:
 *   npx tsx scripts/legacy-main-session-report.ts --check [--db <path>]
 * Opens the database (default: data/db/messages.db under the working
 * directory) with better-sqlite3 readonly, runs the invariant checks that
 * need no pre-migration count in one read snapshot and lists each
 * legacy_main session with its message count. Loads nothing that writes on
 * import.
 *
 * Preview, read-only like --check, on a v87 database before deploying:
 *   npx tsx scripts/legacy-main-session-report.ts --preflight [--db <path>] [--data-dir <path>]
 * Prints what the migration would do (pending inputs it replays or leaves,
 * non-terminal main-lane turns, topic containers, duplicate message ids,
 * inputs without a timestamp, and what sessions/<folder>/.claude is, by
 * lstat only); `clean` is true when none of that applies. The data dir
 * defaults to the directory holding db/. Always exits 0 once it ran.
 *
 * --check and the rehearsal print one JSON document and exit 1 when an
 * invariant check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import {
  checkLegacyMainSessionInvariants,
  countRows,
  listLegacyMainSessions,
  READ_ONLY_OPEN,
  routerState,
} from '../src/legacy-main-session-checks.js';
import { previewLegacyMainSessions } from '../src/legacy-main-session-plan.js';
import { CURRENT_SCHEMA_VERSION } from '../src/schema-version.js';

const DEFAULT_DB = path.join('data', 'db', 'messages.db');

function withReadOnly<T>(
  dbPath: string,
  read: (conn: Database.Database) => T,
): T {
  const conn = new Database(dbPath, READ_ONLY_OPEN);
  try {
    return read(conn);
  } finally {
    conn.close();
  }
}

function countMessages(conn: Database.Database): number {
  return countRows(conn, 'SELECT COUNT(*) AS n FROM messages');
}

/** Print the report; the exit code says whether every check passed. */
function emit(output: { checks: Array<{ ok: boolean }> }): number {
  const ok = output.checks.every((c) => c.ok);
  console.log(JSON.stringify({ ok, ...output }, null, 2));
  return ok ? 0 : 1;
}

function check(dbPath: string): number {
  return withReadOnly(dbPath, (conn) =>
    emit(
      conn.transaction(() => ({
        mode: 'check',
        database: dbPath,
        readOnly: conn.readonly,
        schemaVersion: routerState(conn, 'schema_version') ?? null,
        sessions: listLegacyMainSessions(conn),
        checks: checkLegacyMainSessionInvariants(conn, {
          expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
        }),
      }))(),
    ),
  );
}

async function rehearse(inspectFs: boolean): Promise<number> {
  const checkout = fs.realpathSync(process.cwd());
  const dataDir = path.join(checkout, 'data');
  const dbPath = path.join(checkout, DEFAULT_DB);
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  // A data/ symlinked to a live installation would migrate that one instead.
  if (!fs.realpathSync(dbPath).startsWith(checkout + path.sep)) {
    throw new Error(`Refusing: ${dbPath} resolves outside ${checkout}`);
  }

  const { schemaVersionBefore, messagesBefore } = withReadOnly(
    dbPath,
    (conn) => ({
      schemaVersionBefore: routerState(conn, 'schema_version') ?? null,
      messagesBefore: countMessages(conn),
    }),
  );

  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  // The logger writes to stdout, which carries the JSON; the report has it all.
  process.env.LOG_LEVEL = 'silent';
  const db = await import('../src/db.js');
  const migration = await import('../src/legacy-main-session-migration.js');
  const { legacyMainSessions: report, forgottenLegacyMainState } =
    db.initDatabase({ relocateLegacySessionDirectories: false });
  db.closeDatabase();

  return withReadOnly(dbPath, (conn) => {
    const workspaces = report?.workspaces ?? [];
    return emit({
      database: dbPath,
      schemaVersionBefore,
      migrated: !!report,
      // v88 mappings and OOM counters of sessions that no longer exist, which
      // every startup forgets; the copy has lost them too.
      forgottenLegacyMainState,
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
      sessions: listLegacyMainSessions(conn),
      directories: migration.relocateLegacyMainSessionDirectories(conn, {
        dataDir,
        dryRun: true,
        inspect: inspectFs,
      }),
      checks: checkLegacyMainSessionInvariants(conn, {
        expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
        messagesBefore,
        report,
      }),
    });
  });
}

function preflight(dbPath: string, dataDir: string): number {
  const preview = withReadOnly(dbPath, (conn) =>
    conn.transaction(() => ({
      mode: 'preflight',
      database: dbPath,
      dataDir,
      readOnly: conn.readonly,
      schemaVersion: routerState(conn, 'schema_version') ?? null,
      ...previewLegacyMainSessions(conn, { dataDir }),
    }))(),
  );
  console.log(JSON.stringify(preview, null, 2));
  return 0;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      preflight: { type: 'boolean', default: false },
      db: { type: 'string' },
      'data-dir': { type: 'string' },
      'no-fs': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.check && values.preflight) {
    throw new Error('--check and --preflight are separate runs');
  }
  const readOnly = values.check || values.preflight;
  if (values.db !== undefined && !readOnly) {
    throw new Error('--db is only for --check and --preflight');
  }
  if (values['data-dir'] !== undefined && !values.preflight) {
    throw new Error('--data-dir is only for --preflight');
  }
  const dbPath = path.resolve(values.db ?? DEFAULT_DB);
  if (values.preflight) {
    return preflight(
      dbPath,
      path.resolve(values['data-dir'] ?? path.dirname(path.dirname(dbPath))),
    );
  }
  return values.check ? check(dbPath) : rehearse(!values['no-fs']);
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
