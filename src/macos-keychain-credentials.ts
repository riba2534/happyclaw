/**
 * macOS Keychain credential reconciliation for host-mode Claude runners.
 *
 * Claude Code prefers its Keychain item over `.credentials.json`. HappyClaw
 * therefore has to reconcile that item before every host spawn. A separate
 * ownership item records which provider owns the credential and the last
 * credential fingerprint HappyClaw confirmed. That lets us distinguish an SDK
 * refresh from an explicit provider update without putting tokens in metadata.
 *
 * The Claude item can also contain MCP OAuth state. We only replace or remove
 * `claudeAiOauth`; every unrelated field is preserved.
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';

const SECURITY_BIN = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 10_000;
const NOT_FOUND_MARKER = 'could not be found';
const OWNERSHIP_SUFFIX = '.happyclaw-provider-owner';
/**
 * `security -i` reads each command through a fixed 4096-byte line buffer.
 * Overflowing it is not a clean failure: security runs the truncated prefix —
 * storing a mangled payload — and only then rejects the remainder as an unknown
 * command. A Keychain item that also carries `mcpOAuth` for a handful of MCP
 * servers passes 4KB easily, so any command at risk of crossing this boundary
 * has to go through argv instead. Kept below the real 4096-byte cutoff so the
 * check never depends on counting the trailing newline exactly.
 */
const SECURITY_INTERACTIVE_LINE_LIMIT = 4000;

export interface KeychainClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
}

interface KeychainOwnership {
  version: 1;
  providerId: string;
  credentialFingerprint: string | null;
}

interface SecurityCommandRequest {
  args: string[];
  stdin?: string;
  timeoutMs: number;
}

interface SecurityCommandOutput {
  stdout: string;
  stderr: string;
}

export type SecurityCommandRunner = (
  request: SecurityCommandRequest,
) => Promise<SecurityCommandOutput>;

export interface ReconcileClaudeKeychainOptions {
  providerId: string;
  claudeAiOauth: KeychainClaudeAiOauth;
  persistRefreshedCredentials?: (
    expected: KeychainClaudeAiOauth,
    refreshed: KeychainClaudeAiOauth,
  ) => Promise<boolean> | boolean;
}

export class MacosKeychainCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacosKeychainCredentialError';
  }
}

class SecurityCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/** Service name used by Claude Code for a non-default CLAUDE_CONFIG_DIR. */
export function claudeKeychainServiceName(configDir: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(configDir)
    .digest('hex')
    .slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

export function claudeKeychainOwnershipServiceName(configDir: string): string {
  return `${claudeKeychainServiceName(configDir)}${OWNERSHIP_SUFFIX}`;
}

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)].sort();
}

/** Validate and canonicalize the complete claudeAiOauth value we manage. */
export function normalizeClaudeAiOauth(value: unknown): KeychainClaudeAiOauth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MacosKeychainCredentialError(
      'Keychain claudeAiOauth is not an object',
    );
  }
  const oauth = value as Record<string, unknown>;
  if (
    typeof oauth.accessToken !== 'string' ||
    !oauth.accessToken ||
    typeof oauth.refreshToken !== 'string' ||
    !oauth.refreshToken ||
    typeof oauth.expiresAt !== 'number' ||
    !Number.isFinite(oauth.expiresAt) ||
    !Array.isArray(oauth.scopes) ||
    !oauth.scopes.every(
      (scope) => typeof scope === 'string' && scope.length > 0,
    )
  ) {
    throw new MacosKeychainCredentialError(
      'Keychain claudeAiOauth is incomplete or invalid',
    );
  }
  const normalized: KeychainClaudeAiOauth = {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: normalizeScopes(oauth.scopes as string[]),
  };
  if (
    oauth.subscriptionType !== undefined &&
    (typeof oauth.subscriptionType !== 'string' || !oauth.subscriptionType)
  ) {
    throw new MacosKeychainCredentialError(
      'Keychain claudeAiOauth subscriptionType is invalid',
    );
  }
  if (typeof oauth.subscriptionType === 'string') {
    normalized.subscriptionType = oauth.subscriptionType;
  }
  return normalized;
}

function oauthJson(oauth: KeychainClaudeAiOauth): string {
  return JSON.stringify(normalizeClaudeAiOauth(oauth));
}

function oauthFingerprint(oauth: KeychainClaudeAiOauth): string {
  return crypto.createHash('sha256').update(oauthJson(oauth)).digest('hex');
}

function oauthEqual(
  left: KeychainClaudeAiOauth,
  right: KeychainClaudeAiOauth,
): boolean {
  return oauthJson(left) === oauthJson(right);
}

function sharesCredentialLineage(
  left: KeychainClaudeAiOauth,
  right: KeychainClaudeAiOauth,
): boolean {
  return (
    left.accessToken === right.accessToken ||
    left.refreshToken === right.refreshToken
  );
}

function parsePayload(existingJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingJson);
  } catch {
    throw new MacosKeychainCredentialError(
      'Keychain credential payload is not valid JSON',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MacosKeychainCredentialError(
      'Keychain credential payload is not a JSON object',
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merge the complete normalized OAuth value while preserving MCP OAuth and all
 * other Keychain fields. Returns null only for a semantic no-op.
 */
export function mergeClaudeKeychainPayload(
  existingJson: string,
  claudeAiOauth: KeychainClaudeAiOauth | null,
): string | null {
  const payload = parsePayload(existingJson);
  if (claudeAiOauth === null) {
    if (!('claudeAiOauth' in payload)) return null;
    delete payload.claudeAiOauth;
    return JSON.stringify(payload);
  }

  const desired = normalizeClaudeAiOauth(claudeAiOauth);
  if ('claudeAiOauth' in payload) {
    const existing = normalizeClaudeAiOauth(payload.claudeAiOauth);
    if (oauthEqual(existing, desired)) return null;
  }
  payload.claudeAiOauth = desired;
  return JSON.stringify(payload);
}

function quoteSecurityInteractive(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

async function defaultSecurityRunner(
  request: SecurityCommandRequest,
): Promise<SecurityCommandOutput> {
  return await new Promise<SecurityCommandOutput>((resolve, reject) => {
    const child = spawn(SECURITY_BIN, request.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new SecurityCommandError(
            'security command timed out',
            Buffer.concat(stderr).toString('utf8'),
            null,
          ),
        ),
      );
    }, request.timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.from(chunk));
    });
    child.stdin.on('error', (err) => {
      finish(() =>
        reject(
          new SecurityCommandError(
            `security stdin failed: ${err.message}`,
            Buffer.concat(stderr).toString('utf8'),
            null,
          ),
        ),
      );
    });
    child.on('error', (err) => {
      finish(() =>
        reject(
          new SecurityCommandError(`security failed: ${err.message}`, '', null),
        ),
      );
    });
    child.on('close', (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (timedOut) {
        finish(() =>
          reject(
            new SecurityCommandError(
              'security command timed out',
              stderrText,
              null,
            ),
          ),
        );
      } else if (code !== 0) {
        finish(() =>
          reject(
            new SecurityCommandError(
              `security exited with ${code ?? signal ?? 'unknown status'}`,
              stderrText,
              code,
            ),
          ),
        );
      } else {
        finish(() => resolve({ stdout: stdoutText, stderr: stderrText }));
      }
    });
    if (request.stdin !== undefined) child.stdin.end(request.stdin);
    else child.stdin.end();
  });
}

function parseOwnership(json: string): KeychainOwnership {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new MacosKeychainCredentialError(
      'Keychain provider ownership payload is not valid JSON',
    );
  }
  const value = parsed as Partial<KeychainOwnership> | null;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.providerId !== 'string' ||
    !value.providerId ||
    (value.credentialFingerprint !== null &&
      typeof value.credentialFingerprint !== 'string')
  ) {
    throw new MacosKeychainCredentialError(
      'Keychain provider ownership payload is invalid',
    );
  }
  return value as KeychainOwnership;
}

export class MacosKeychainCredentialStore {
  private readonly serviceQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly account: () => string = () => os.userInfo().username,
    private readonly runSecurity: SecurityCommandRunner = defaultSecurityRunner,
  ) {}

  private async withServiceLock<T>(
    service: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.serviceQueues.get(service) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.serviceQueues.set(service, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.serviceQueues.get(service) === tail) {
        this.serviceQueues.delete(service);
      }
    }
  }

  private async read(service: string): Promise<string | null> {
    let account: string;
    try {
      account = this.account();
    } catch {
      throw new MacosKeychainCredentialError(
        'Unable to resolve the macOS Keychain account',
      );
    }
    try {
      const output = await this.runSecurity({
        args: ['find-generic-password', '-s', service, '-a', account, '-w'],
        timeoutMs: SECURITY_TIMEOUT_MS,
      });
      return output.stdout.trim();
    } catch (err) {
      const stderr =
        err instanceof SecurityCommandError
          ? err.stderr
          : typeof (err as { stderr?: unknown })?.stderr === 'string'
            ? ((err as { stderr: string }).stderr ?? '')
            : '';
      if (
        (err instanceof SecurityCommandError && err.exitCode === 44) ||
        stderr.toLowerCase().includes(NOT_FOUND_MARKER)
      ) {
        return null;
      }
      throw new MacosKeychainCredentialError(
        `Unable to read macOS Keychain item ${service}`,
      );
    }
  }

  private async write(service: string, payload: string): Promise<void> {
    let account: string;
    try {
      account = this.account();
    } catch {
      throw new MacosKeychainCredentialError(
        'Unable to resolve the macOS Keychain account',
      );
    }
    const input = [
      'add-generic-password',
      '-U',
      '-s',
      quoteSecurityInteractive(service),
      '-a',
      quoteSecurityInteractive(account),
      '-w',
      quoteSecurityInteractive(payload),
    ].join(' ');
    try {
      // `security -i` reads the command from stdin, so OAuth/MCP payloads never
      // appear in process argv or the process environment. Prefer it whenever
      // the command fits, and fall back to argv rather than let the payload be
      // silently truncated (see SECURITY_INTERACTIVE_LINE_LIMIT). The fallback
      // trades argv exposure for correctness: a corrupted credential item locks
      // the user out of host mode, and the value is only readable by processes
      // already running as the same user.
      const request: SecurityCommandRequest =
        Buffer.byteLength(input, 'utf8') + 1 <= SECURITY_INTERACTIVE_LINE_LIMIT
          ? {
              args: ['-i'],
              stdin: `${input}\n`,
              timeoutMs: SECURITY_TIMEOUT_MS,
            }
          : {
              args: [
                'add-generic-password',
                '-U',
                '-s',
                service,
                '-a',
                account,
                '-w',
                payload,
              ],
              timeoutMs: SECURITY_TIMEOUT_MS,
            };
      await this.runSecurity(request);
    } catch {
      throw new MacosKeychainCredentialError(
        `Unable to write macOS Keychain item ${service}`,
      );
    }
  }

  private async writeOwnership(
    service: string,
    providerId: string,
    credentialFingerprint: string | null,
  ): Promise<void> {
    await this.write(
      `${service}${OWNERSHIP_SUFFIX}`,
      JSON.stringify({
        version: 1,
        providerId,
        credentialFingerprint,
      } satisfies KeychainOwnership),
    );
  }

  async reconcile(
    configDir: string,
    options: ReconcileClaudeKeychainOptions,
  ): Promise<KeychainClaudeAiOauth> {
    const desired = normalizeClaudeAiOauth(options.claudeAiOauth);
    if (this.platform !== 'darwin') return desired;
    if (!options.providerId) {
      throw new MacosKeychainCredentialError(
        'A provider ID is required for macOS Keychain OAuth reconciliation',
      );
    }

    const service = claudeKeychainServiceName(configDir);
    return await this.withServiceLock(service, async () => {
      const [existingJson, ownershipJson] = await Promise.all([
        this.read(service),
        this.read(`${service}${OWNERSHIP_SUFFIX}`),
      ]);
      const desiredFingerprint = oauthFingerprint(desired);
      const ownership = ownershipJson ? parseOwnership(ownershipJson) : null;

      if (existingJson === null) {
        await this.writeOwnership(
          service,
          options.providerId,
          desiredFingerprint,
        );
        return desired;
      }

      const payload = parsePayload(existingJson);
      const existingOauth =
        payload.claudeAiOauth === undefined
          ? null
          : normalizeClaudeAiOauth(payload.claudeAiOauth);

      if (existingOauth === null) {
        const merged = mergeClaudeKeychainPayload(existingJson, desired);
        if (merged !== null) await this.write(service, merged);
        await this.writeOwnership(
          service,
          options.providerId,
          desiredFingerprint,
        );
        return desired;
      }

      const existingFingerprint = oauthFingerprint(existingOauth);
      if (!ownership) {
        if (oauthEqual(existingOauth, desired)) {
          await this.writeOwnership(
            service,
            options.providerId,
            desiredFingerprint,
          );
          return desired;
        }
        if (!sharesCredentialLineage(existingOauth, desired)) {
          // No ownership item means this is the first reconcile after the
          // upgrade that introduced ownership tracking, so an unrelated
          // credential is the expected state rather than a suspicious one.
          //
          // Failing closed here is unrecoverable for a multi-account provider
          // pool: the item holds whichever account was seeded last, the pool
          // keeps rotating, and no selected provider can ever match it — so
          // host mode stays blocked for every provider, forever, with no
          // supported way to clear the item.
          //
          // There is also no third party to protect. The service name is
          // derived from HappyClaw's own CLAUDE_CONFIG_DIR, so HappyClaw is the
          // only writer of that item. Adopt the selected provider and record
          // ownership; this is a one-shot migration that reproduces the
          // pre-ownership behaviour, and every later reconcile takes the
          // rotation-aware branches below.
          const migrated = mergeClaudeKeychainPayload(existingJson, desired);
          if (migrated !== null) await this.write(service, migrated);
          await this.writeOwnership(
            service,
            options.providerId,
            desiredFingerprint,
          );
          return desired;
        }
        if (existingOauth.expiresAt > desired.expiresAt) {
          await this.persistRefresh(options, desired, existingOauth);
          await this.writeOwnership(
            service,
            options.providerId,
            existingFingerprint,
          );
          return existingOauth;
        }
        const merged = mergeClaudeKeychainPayload(existingJson, desired);
        if (merged !== null) await this.write(service, merged);
        await this.writeOwnership(
          service,
          options.providerId,
          desiredFingerprint,
        );
        return desired;
      }

      if (ownership.providerId !== options.providerId) {
        const merged = mergeClaudeKeychainPayload(existingJson, desired);
        if (merged !== null) await this.write(service, merged);
        await this.writeOwnership(
          service,
          options.providerId,
          desiredFingerprint,
        );
        return desired;
      }

      if (existingFingerprint === desiredFingerprint) {
        if (ownership.credentialFingerprint !== desiredFingerprint) {
          await this.writeOwnership(
            service,
            options.providerId,
            desiredFingerprint,
          );
        }
        return desired;
      }

      if (ownership.credentialFingerprint === desiredFingerprint) {
        await this.persistRefresh(options, desired, existingOauth);
        await this.writeOwnership(
          service,
          options.providerId,
          existingFingerprint,
        );
        return existingOauth;
      }

      if (ownership.credentialFingerprint === existingFingerprint) {
        const merged = mergeClaudeKeychainPayload(existingJson, desired);
        if (merged !== null) await this.write(service, merged);
        await this.writeOwnership(
          service,
          options.providerId,
          desiredFingerprint,
        );
        return desired;
      }

      throw new MacosKeychainCredentialError(
        'Provider and Keychain OAuth credentials changed concurrently',
      );
    });
  }

  private async persistRefresh(
    options: ReconcileClaudeKeychainOptions,
    expected: KeychainClaudeAiOauth,
    refreshed: KeychainClaudeAiOauth,
  ): Promise<void> {
    if (!options.persistRefreshedCredentials) {
      throw new MacosKeychainCredentialError(
        'Refreshed Keychain OAuth credentials cannot be persisted',
      );
    }
    let persisted: boolean;
    try {
      persisted = await options.persistRefreshedCredentials(
        expected,
        refreshed,
      );
    } catch {
      throw new MacosKeychainCredentialError(
        'Unable to persist refreshed Keychain OAuth credentials',
      );
    }
    if (!persisted) {
      throw new MacosKeychainCredentialError(
        'Provider OAuth credentials changed during Keychain reconciliation',
      );
    }
  }

  async remove(configDir: string, providerId: string): Promise<void> {
    if (this.platform !== 'darwin') return;
    if (!providerId) {
      throw new MacosKeychainCredentialError(
        'A provider ID is required for macOS Keychain OAuth cleanup',
      );
    }
    const service = claudeKeychainServiceName(configDir);
    await this.withServiceLock(service, async () => {
      const [existingJson, ownershipJson] = await Promise.all([
        this.read(service),
        this.read(`${service}${OWNERSHIP_SUFFIX}`),
      ]);
      if (ownershipJson !== null) parseOwnership(ownershipJson);
      if (existingJson !== null) {
        const merged = mergeClaudeKeychainPayload(existingJson, null);
        if (merged !== null) await this.write(service, merged);
      }
      await this.writeOwnership(service, providerId, null);
    });
  }
}

const defaultStore = new MacosKeychainCredentialStore();

export async function syncClaudeKeychainOAuth(
  configDir: string,
  options: ReconcileClaudeKeychainOptions,
): Promise<KeychainClaudeAiOauth> {
  return await defaultStore.reconcile(configDir, options);
}

export async function removeClaudeKeychainOAuth(
  configDir: string,
  providerId: string,
): Promise<void> {
  await defaultStore.remove(configDir, providerId);
}
