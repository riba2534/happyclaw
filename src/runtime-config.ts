import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { logger } from './logger.js';

const MAX_FIELD_LENGTH = 2000;
const CURRENT_CONFIG_VERSION = 3;
const DEFAULT_THIRD_PARTY_PROFILE_ID = 'default';
const DEFAULT_THIRD_PARTY_PROFILE_NAME = '默认第三方';
const OFFICIAL_CLAUDE_PROFILE_ID = '__official__';

const CLAUDE_CONFIG_DIR = path.join(DATA_DIR, 'config');
const CLAUDE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'claude-provider.json');
const CLAUDE_CONFIG_KEY_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.key',
);
const CLAUDE_CONFIG_AUDIT_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.audit.log',
);
const CLAUDE_CUSTOM_ENV_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-custom-env.json',
);
const FEISHU_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'feishu-provider.json');
const TELEGRAM_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'telegram-provider.json',
);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_CLAUDE_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'HAPPYCLAW_MODEL',
]);
const DANGEROUS_ENV_VARS = new Set([
  // Code execution / preload attacks
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'PERL5OPT',
  // Path manipulation
  'PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'PERL5LIB',
  'GIT_EXEC_PATH',
  'CDPATH',
  // Shell behavior
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  // Editor / terminal (可被利用执行命令)
  'EDITOR',
  'VISUAL',
  'PAGER',
  // SSH / Git（防止凭据泄露或命令注入）
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  // Sensitive directories
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  // HappyClaw 内部路径映射
  'HAPPYCLAW_WORKSPACE_GROUP',
  'HAPPYCLAW_WORKSPACE_GLOBAL',
  'HAPPYCLAW_WORKSPACE_IPC',
  'CLAUDE_CONFIG_DIR',
]);
const MAX_CUSTOM_ENV_ENTRIES = 50;
const MAX_THIRD_PARTY_PROFILES = 20;

type ClaudeProviderMode = 'official' | 'third_party';

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  scopes: string[];
}

export interface ClaudeProviderConfig {
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: ClaudeOAuthCredentials | null;
  happyclawModel: string;
  updatedAt: string | null;
}

export interface ClaudeProviderPublicConfig {
  anthropicBaseUrl: string;
  happyclawModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
}

export interface ClaudeThirdPartyProfile {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  happyclawModel: string;
  updatedAt: string | null;
  customEnv: Record<string, string>;
}

export interface ClaudeThirdPartyProfilePublic {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  happyclawModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  customEnv: Record<string, string>;
}

export interface FeishuProviderConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type FeishuConfigSource = 'runtime' | 'env' | 'none';

export interface FeishuProviderPublicConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  updatedAt: string | null;
  source: FeishuConfigSource;
}

export interface TelegramProviderConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type TelegramConfigSource = 'runtime' | 'env' | 'none';

export interface TelegramProviderPublicConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  proxyUrl: string;
  enabled: boolean;
  updatedAt: string | null;
  source: TelegramConfigSource;
}

interface SecretPayload {
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
}

interface EncryptedSecrets {
  iv: string;
  tag: string;
  data: string;
}

interface FeishuSecretPayload {
  appSecret: string;
}

interface TelegramSecretPayload {
  botToken: string;
}

interface StoredFeishuProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface StoredTelegramProviderConfigV1 {
  version: 1;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface StoredClaudeProviderConfigV2 {
  version: 2;
  anthropicBaseUrl: string;
  updatedAt: string;
  secrets: EncryptedSecrets;
}

interface StoredClaudeThirdPartyProfileV1 {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  happyclawModel: string;
  updatedAt: string;
  secrets: EncryptedSecrets;
  customEnv?: Record<string, string>;
}

interface StoredClaudeProviderConfigV3 {
  version: 3;
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  official: {
    updatedAt: string;
    secrets: EncryptedSecrets;
    customEnv?: Record<string, string>;
  };
}

interface StoredClaudeProviderConfigLegacy {
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  updatedAt?: string;
}

interface ClaudeStoredStateV3Resolved {
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  officialSecrets: SecretPayload;
  officialUpdatedAt: string | null;
  officialCustomEnv: Record<string, string>;
}

interface ClaudeStoredProfileResolved {
  mode: ClaudeProviderMode;
  profile: ClaudeThirdPartyProfile | null;
  officialSecrets: SecretPayload;
  officialUpdatedAt: string | null;
}

interface ClaudeConfigAuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  changedFields: string[];
  metadata?: Record<string, unknown>;
}

function normalizeSecret(input: unknown, fieldName: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Invalid field: ${fieldName}`);
  }
  // Strip ALL whitespace and non-ASCII characters — API keys/tokens are always ASCII;
  // users often paste with accidental spaces, line breaks, or smart quotes (e.g. U+2019).
  // eslint-disable-next-line no-control-regex
  const value = input.replace(/\s+/g, '').replace(/[^\x00-\x7F]/g, '');
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error(`Field too long: ${fieldName}`);
  }
  return value;
}

function normalizeBaseUrl(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: anthropicBaseUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  return value;
}

function normalizeModel(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: happyclawModel');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > 128) {
    throw new Error('Field too long: happyclawModel');
  }
  return value;
}

function normalizeFeishuAppId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: appId');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: appId');
  }
  return value;
}

function normalizeTelegramProxyUrl(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new Error('Invalid field: proxyUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: proxyUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: proxyUrl');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(protocol)) {
    throw new Error('Invalid field: proxyUrl');
  }
  return value;
}

function normalizeProfileName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: name');
  }
  const value = input.trim();
  if (!value) {
    throw new Error('Invalid field: name');
  }
  if (value.length > 64) {
    throw new Error('Field too long: name');
  }
  return value;
}

function normalizeProfileId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: id');
  }
  const value = input.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new Error('Invalid field: id');
  }
  return value;
}

function sanitizeCustomEnvMap(
  input: Record<string, string>,
  options?: { skipReservedClaudeKeys?: boolean },
): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > MAX_CUSTOM_ENV_ENTRIES) {
    throw new Error(
      `customEnv must have at most ${MAX_CUSTOM_ENV_ENTRIES} entries`,
    );
  }

  const out: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }
    if (options?.skipReservedClaudeKeys && RESERVED_CLAUDE_ENV_KEYS.has(key)) {
      continue;
    }
    out[key] = sanitizeEnvValue(
      typeof rawValue === 'string' ? rawValue : String(rawValue),
    );
  }
  return out;
}

function normalizeConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
): Omit<ClaudeProviderConfig, 'updatedAt'> {
  return {
    anthropicBaseUrl: normalizeBaseUrl(input.anthropicBaseUrl),
    anthropicAuthToken: normalizeSecret(
      input.anthropicAuthToken,
      'anthropicAuthToken',
    ),
    anthropicApiKey: normalizeSecret(input.anthropicApiKey, 'anthropicApiKey'),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken,
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
    happyclawModel: normalizeModel(input.happyclawModel),
  };
}

function buildConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
  updatedAt: string | null,
): ClaudeProviderConfig {
  return {
    ...normalizeConfig(input),
    updatedAt,
  };
}

function getOrCreateEncryptionKey(): Buffer {
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });

  if (fs.existsSync(CLAUDE_CONFIG_KEY_FILE)) {
    const raw = fs.readFileSync(CLAUDE_CONFIG_KEY_FILE, 'utf-8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length === 32) return key;
    throw new Error('Invalid encryption key file');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(CLAUDE_CONFIG_KEY_FILE, key.toString('hex') + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return key;
}

function encryptSecrets(payload: SecretPayload): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptSecrets(secrets: EncryptedSecrets): SecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');

  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  const result: SecretPayload = {
    anthropicAuthToken: normalizeSecret(
      parsed.anthropicAuthToken ?? '',
      'anthropicAuthToken',
    ),
    anthropicApiKey: normalizeSecret(
      parsed.anthropicApiKey ?? '',
      'anthropicApiKey',
    ),
    claudeCodeOauthToken: normalizeSecret(
      parsed.claudeCodeOauthToken ?? '',
      'claudeCodeOauthToken',
    ),
  };
  // Restore OAuth credentials if present
  if (
    parsed.claudeOAuthCredentials &&
    typeof parsed.claudeOAuthCredentials === 'object'
  ) {
    const creds = parsed.claudeOAuthCredentials as Record<string, unknown>;
    if (
      typeof creds.accessToken === 'string' &&
      typeof creds.refreshToken === 'string'
    ) {
      result.claudeOAuthCredentials = {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: typeof creds.expiresAt === 'number' ? creds.expiresAt : 0,
        scopes: Array.isArray(creds.scopes) ? (creds.scopes as string[]) : [],
      };
    }
  }
  return result;
}

function encryptFeishuSecret(payload: FeishuSecretPayload): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptFeishuSecret(secrets: EncryptedSecrets): FeishuSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  return {
    appSecret: normalizeSecret(parsed.appSecret ?? '', 'appSecret'),
  };
}

function readLegacyConfig(
  raw: StoredClaudeProviderConfigLegacy,
): ClaudeProviderConfig {
  return buildConfig(
    {
      anthropicBaseUrl: raw.anthropicBaseUrl ?? '',
      anthropicAuthToken: raw.anthropicAuthToken ?? '',
      anthropicApiKey: raw.anthropicApiKey ?? '',
      claudeCodeOauthToken: raw.claudeCodeOauthToken ?? '',
      claudeOAuthCredentials: null,
      happyclawModel: process.env.HAPPYCLAW_MODEL || '',
    },
    typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  );
}

function toStoredProfile(
  profile: ClaudeThirdPartyProfile,
): StoredClaudeThirdPartyProfileV1 {
  const sanitizedEnv = sanitizeCustomEnvMap(profile.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
  return {
    id: normalizeProfileId(profile.id),
    name: normalizeProfileName(profile.name),
    anthropicBaseUrl: normalizeBaseUrl(profile.anthropicBaseUrl),
    happyclawModel: normalizeModel(profile.happyclawModel),
    updatedAt: profile.updatedAt || new Date().toISOString(),
    secrets: encryptSecrets({
      anthropicAuthToken: normalizeSecret(
        profile.anthropicAuthToken,
        'anthropicAuthToken',
      ),
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    }),
    ...(Object.keys(sanitizedEnv).length > 0
      ? { customEnv: sanitizedEnv }
      : {}),
  };
}

function fromStoredProfile(
  stored: StoredClaudeThirdPartyProfileV1,
): ClaudeThirdPartyProfile {
  const secrets = decryptSecrets(stored.secrets);
  return {
    id: normalizeProfileId(stored.id),
    name: normalizeProfileName(stored.name),
    anthropicBaseUrl: normalizeBaseUrl(stored.anthropicBaseUrl),
    anthropicAuthToken: secrets.anthropicAuthToken,
    happyclawModel: normalizeModel(stored.happyclawModel ?? ''),
    updatedAt: stored.updatedAt || null,
    customEnv: sanitizeCustomEnvMap(stored.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
  };
}

function makeDefaultThirdPartyProfile(
  config: ClaudeProviderConfig,
): ClaudeThirdPartyProfile {
  return {
    id: DEFAULT_THIRD_PARTY_PROFILE_ID,
    name: DEFAULT_THIRD_PARTY_PROFILE_NAME,
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicAuthToken: config.anthropicAuthToken,
    happyclawModel: normalizeModel(
      config.happyclawModel || process.env.HAPPYCLAW_MODEL || '',
    ),
    updatedAt: config.updatedAt || new Date().toISOString(),
    customEnv: {},
  };
}

function normalizeOfficialSecrets(input: SecretPayload): SecretPayload {
  return {
    anthropicAuthToken: '',
    anthropicApiKey: normalizeSecret(
      input.anthropicApiKey ?? '',
      'anthropicApiKey',
    ),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken ?? '',
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
  };
}

function isOfficialClaudeMode(activeProfileId: string): boolean {
  return activeProfileId === OFFICIAL_CLAUDE_PROFILE_ID;
}

function buildOfficialClaudeProviderConfig(
  officialSecrets: SecretPayload,
  officialUpdatedAt: string | null,
): ClaudeProviderConfig {
  return buildConfig(
    {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials: officialSecrets.claudeOAuthCredentials ?? null,
      happyclawModel: '',
    },
    officialUpdatedAt,
  );
}

function normalizeStoredState(
  state: ClaudeStoredStateV3Resolved,
): ClaudeStoredStateV3Resolved {
  const normalizedProfiles = state.profiles
    .map((item) => fromStoredProfile(item))
    .slice(0, MAX_THIRD_PARTY_PROFILES)
    .map((profile) => toStoredProfile(profile));

  const officialSecrets = normalizeOfficialSecrets(state.officialSecrets);
  const officialMode = isOfficialClaudeMode(state.activeProfileId);
  let officialCustomEnv = sanitizeCustomEnvMap(state.officialCustomEnv || {}, {
    skipReservedClaudeKeys: true,
  });

  // Lazy migration: if all profiles have empty customEnv, migrate from legacy global file
  const allEmpty =
    Object.keys(officialCustomEnv).length === 0 &&
    normalizedProfiles.every(
      (p) => !p.customEnv || Object.keys(p.customEnv).length === 0,
    );
  if (allEmpty) {
    try {
      if (fs.existsSync(CLAUDE_CUSTOM_ENV_FILE)) {
        const parsed = JSON.parse(
          fs.readFileSync(CLAUDE_CUSTOM_ENV_FILE, 'utf-8'),
        ) as { customEnv?: Record<string, string> };
        const legacyEnv = sanitizeCustomEnvMap(parsed.customEnv || {}, {
          skipReservedClaudeKeys: true,
        });
        if (Object.keys(legacyEnv).length > 0) {
          if (officialMode) {
            officialCustomEnv = legacyEnv;
          } else {
            // Assign to the active profile
            const activeIdx = normalizedProfiles.findIndex(
              (p) => p.id === state.activeProfileId,
            );
            if (activeIdx >= 0) {
              normalizedProfiles[activeIdx] = {
                ...normalizedProfiles[activeIdx],
                customEnv: legacyEnv,
              };
            }
          }
          logger.info('Migrated legacy global customEnv to active profile');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to migrate legacy global customEnv');
    }
  }

  if (normalizedProfiles.length === 0) {
    if (officialMode) {
      return {
        activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
        profiles: [],
        officialSecrets,
        officialUpdatedAt: state.officialUpdatedAt,
        officialCustomEnv,
      };
    }

    const defaultProfile = toStoredProfile(
      makeDefaultThirdPartyProfile({
        anthropicBaseUrl: '',
        anthropicAuthToken: '',
        anthropicApiKey: '',
        claudeCodeOauthToken: '',
        claudeOAuthCredentials: null,
        happyclawModel: process.env.HAPPYCLAW_MODEL || '',
        updatedAt: null,
      }),
    );
    return {
      activeProfileId: defaultProfile.id,
      profiles: [defaultProfile],
      officialSecrets,
      officialUpdatedAt: state.officialUpdatedAt,
      officialCustomEnv,
    };
  }

  const hasActive = normalizedProfiles.some(
    (item) => item.id === state.activeProfileId,
  );
  const activeProfileId = officialMode
    ? OFFICIAL_CLAUDE_PROFILE_ID
    : hasActive
      ? state.activeProfileId
      : normalizedProfiles[0].id;

  return {
    activeProfileId,
    profiles: normalizedProfiles,
    officialSecrets,
    officialUpdatedAt: state.officialUpdatedAt,
    officialCustomEnv,
  };
}

function readStoredState(): ClaudeStoredStateV3Resolved | null {
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return null;
  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (parsed.version === 3) {
      const v3 = parsed as unknown as StoredClaudeProviderConfigV3;
      const profiles = Array.isArray(v3.profiles) ? v3.profiles : [];
      const officialSecrets = v3.official
        ? decryptSecrets(v3.official.secrets)
        : {
            anthropicAuthToken: '',
            anthropicApiKey: '',
            claudeCodeOauthToken: '',
            claudeOAuthCredentials: null,
          };
      return normalizeStoredState({
        activeProfileId:
          typeof v3.activeProfileId === 'string'
            ? isOfficialClaudeMode(v3.activeProfileId)
              ? OFFICIAL_CLAUDE_PROFILE_ID
              : normalizeProfileId(v3.activeProfileId)
            : DEFAULT_THIRD_PARTY_PROFILE_ID,
        profiles: profiles as StoredClaudeThirdPartyProfileV1[],
        officialSecrets,
        officialUpdatedAt: v3.official?.updatedAt || null,
        officialCustomEnv: v3.official?.customEnv || {},
      });
    }

    if (parsed.version === 2) {
      const v2 = parsed as unknown as StoredClaudeProviderConfigV2;
      const secrets = decryptSecrets(v2.secrets);
      const legacyConfig = buildConfig(
        {
          anthropicBaseUrl: v2.anthropicBaseUrl,
          anthropicAuthToken: secrets.anthropicAuthToken,
          anthropicApiKey: secrets.anthropicApiKey,
          claudeCodeOauthToken: secrets.claudeCodeOauthToken,
          claudeOAuthCredentials: secrets.claudeOAuthCredentials ?? null,
          happyclawModel: process.env.HAPPYCLAW_MODEL || '',
        },
        v2.updatedAt || null,
      );
      const profile = toStoredProfile(
        makeDefaultThirdPartyProfile(legacyConfig),
      );
      return normalizeStoredState({
        activeProfileId: profile.id,
        profiles: [profile],
        officialSecrets: {
          anthropicAuthToken: '',
          anthropicApiKey: legacyConfig.anthropicApiKey,
          claudeCodeOauthToken: legacyConfig.claudeCodeOauthToken,
          claudeOAuthCredentials: legacyConfig.claudeOAuthCredentials,
        },
        officialUpdatedAt: legacyConfig.updatedAt,
        officialCustomEnv: {},
      });
    }

    const legacy = readLegacyConfig(parsed as StoredClaudeProviderConfigLegacy);
    const profile = toStoredProfile(makeDefaultThirdPartyProfile(legacy));
    return normalizeStoredState({
      activeProfileId: profile.id,
      profiles: [profile],
      officialSecrets: {
        anthropicAuthToken: '',
        anthropicApiKey: legacy.anthropicApiKey,
        claudeCodeOauthToken: legacy.claudeCodeOauthToken,
        claudeOAuthCredentials: legacy.claudeOAuthCredentials,
      },
      officialUpdatedAt: legacy.updatedAt,
      officialCustomEnv: {},
    });
  } catch (err) {
    logger.error(
      { err, file: CLAUDE_CONFIG_FILE },
      'Failed to read Claude provider config, falling back to defaults',
    );
    return null;
  }
}

function writeStoredState(state: ClaudeStoredStateV3Resolved): void {
  const normalized = normalizeStoredState(state);
  const payload: StoredClaudeProviderConfigV3 = {
    version: CURRENT_CONFIG_VERSION,
    activeProfileId: normalized.activeProfileId,
    profiles: normalized.profiles,
    official: {
      updatedAt: normalized.officialUpdatedAt || new Date().toISOString(),
      secrets: encryptSecrets({
        anthropicAuthToken: '',
        anthropicApiKey: normalized.officialSecrets.anthropicApiKey,
        claudeCodeOauthToken: normalized.officialSecrets.claudeCodeOauthToken,
        claudeOAuthCredentials:
          normalized.officialSecrets.claudeOAuthCredentials,
      }),
      ...(Object.keys(normalized.officialCustomEnv || {}).length > 0
        ? { customEnv: normalized.officialCustomEnv }
        : {}),
    },
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${CLAUDE_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, CLAUDE_CONFIG_FILE);
}

function resolveActiveProfile(
  state: ClaudeStoredStateV3Resolved,
): ClaudeStoredProfileResolved {
  if (isOfficialClaudeMode(state.activeProfileId)) {
    return {
      mode: 'official',
      profile: null,
      officialSecrets: state.officialSecrets,
      officialUpdatedAt: state.officialUpdatedAt,
    };
  }

  const active =
    state.profiles.find((item) => item.id === state.activeProfileId) ||
    state.profiles[0];
  if (!active) {
    return {
      mode: 'official',
      profile: null,
      officialSecrets: state.officialSecrets,
      officialUpdatedAt: state.officialUpdatedAt,
    };
  }

  const profile = fromStoredProfile(active);
  return {
    mode: 'third_party',
    profile,
    officialSecrets: state.officialSecrets,
    officialUpdatedAt: state.officialUpdatedAt,
  };
}

function readStoredConfig(): ClaudeProviderConfig | null {
  const state = readStoredState();
  if (!state) return null;
  const resolved = resolveActiveProfile(state);
  if (resolved.mode === 'official' || !resolved.profile) {
    return buildOfficialClaudeProviderConfig(
      resolved.officialSecrets,
      resolved.officialUpdatedAt,
    );
  }

  return buildConfig(
    {
      anthropicBaseUrl: resolved.profile.anthropicBaseUrl,
      anthropicAuthToken: resolved.profile.anthropicAuthToken,
      anthropicApiKey: resolved.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: resolved.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        resolved.officialSecrets.claudeOAuthCredentials ?? null,
      happyclawModel: resolved.profile.happyclawModel,
    },
    resolved.profile.updatedAt || resolved.officialUpdatedAt,
  );
}

function defaultsFromEnv(): ClaudeProviderConfig {
  const raw = {
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    claudeOAuthCredentials: null,
    happyclawModel: process.env.HAPPYCLAW_MODEL || '',
  };

  try {
    return buildConfig(raw, null);
  } catch {
    return {
      anthropicBaseUrl: '',
      anthropicAuthToken: raw.anthropicAuthToken.trim(),
      anthropicApiKey: raw.anthropicApiKey.trim(),
      claudeCodeOauthToken: raw.claudeCodeOauthToken.trim(),
      claudeOAuthCredentials: null,
      happyclawModel: raw.happyclawModel.trim(),
      updatedAt: null,
    };
  }
}

function readStoredFeishuConfig(): FeishuProviderConfig | null {
  if (!fs.existsSync(FEISHU_CONFIG_FILE)) return null;
  const content = fs.readFileSync(FEISHU_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredFeishuProviderConfigV1;
  const secret = decryptFeishuSecret(stored.secret);
  return {
    appId: normalizeFeishuAppId(stored.appId ?? ''),
    appSecret: secret.appSecret,
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsFeishuFromEnv(): FeishuProviderConfig {
  const raw = {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
  };
  return {
    appId: raw.appId.trim(),
    appSecret: raw.appSecret.trim(),
    updatedAt: null,
  };
}

export function getFeishuProviderConfigWithSource(): {
  config: FeishuProviderConfig;
  source: FeishuConfigSource;
} {
  try {
    const stored = readStoredFeishuConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Feishu config, falling back to env',
    );
  }

  const fromEnv = defaultsFeishuFromEnv();
  if (fromEnv.appId || fromEnv.appSecret) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getFeishuProviderConfig(): FeishuProviderConfig {
  return getFeishuProviderConfigWithSource().config;
}

export function saveFeishuProviderConfig(
  next: Omit<FeishuProviderConfig, 'updatedAt'>,
): FeishuProviderConfig {
  const normalized: FeishuProviderConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptFeishuSecret({ appSecret: normalized.appSecret }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${FEISHU_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, FEISHU_CONFIG_FILE);
  return normalized;
}

export function toPublicFeishuProviderConfig(
  config: FeishuProviderConfig,
  source: FeishuConfigSource,
): FeishuProviderPublicConfig {
  return {
    appId: config.appId,
    hasAppSecret: !!config.appSecret,
    appSecretMasked: maskSecret(config.appSecret),
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

// ========== Telegram Provider Config ==========

function encryptTelegramSecret(
  payload: TelegramSecretPayload,
): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptTelegramSecret(
  secrets: EncryptedSecrets,
): TelegramSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  return {
    botToken: normalizeSecret(parsed.botToken ?? '', 'botToken'),
  };
}

function readStoredTelegramConfig(): TelegramProviderConfig | null {
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) return null;
  const content = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredTelegramProviderConfigV1;
  const secret = decryptTelegramSecret(stored.secret);
  return {
    botToken: secret.botToken,
    proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsTelegramFromEnv(): TelegramProviderConfig {
  const raw = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    proxyUrl: process.env.TELEGRAM_PROXY_URL || '',
  };
  return {
    botToken: raw.botToken.trim(),
    proxyUrl: normalizeTelegramProxyUrl(raw.proxyUrl),
    updatedAt: null,
  };
}

export function getTelegramProviderConfigWithSource(): {
  config: TelegramProviderConfig;
  source: TelegramConfigSource;
} {
  try {
    const stored = readStoredTelegramConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Telegram config, falling back to env',
    );
  }

  const fromEnv = defaultsTelegramFromEnv();
  if (fromEnv.botToken) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getTelegramProviderConfig(): TelegramProviderConfig {
  return getTelegramProviderConfigWithSource().config;
}

export function saveTelegramProviderConfig(
  next: Omit<TelegramProviderConfig, 'updatedAt'>,
): TelegramProviderConfig {
  const normalized: TelegramProviderConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizeTelegramProxyUrl(next.proxyUrl),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalized.proxyUrl,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptTelegramSecret({ botToken: normalized.botToken }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${TELEGRAM_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, TELEGRAM_CONFIG_FILE);
  return normalized;
}

export function toPublicTelegramProviderConfig(
  config: TelegramProviderConfig,
  source: TelegramConfigSource,
): TelegramProviderPublicConfig {
  return {
    hasBotToken: !!config.botToken,
    botTokenMasked: maskSecret(config.botToken),
    proxyUrl: config.proxyUrl ?? '',
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8)
    return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
}

export function toPublicClaudeProviderConfig(
  config: ClaudeProviderConfig,
): ClaudeProviderPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl,
    happyclawModel: config.happyclawModel,
    updatedAt: config.updatedAt,
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken),
    hasClaudeOAuthCredentials: !!config.claudeOAuthCredentials,
    claudeOAuthCredentialsExpiresAt:
      config.claudeOAuthCredentials?.expiresAt ?? null,
    claudeOAuthCredentialsAccessTokenMasked: config.claudeOAuthCredentials
      ? maskSecret(config.claudeOAuthCredentials.accessToken)
      : null,
  };
}

export function validateClaudeProviderConfig(
  config: ClaudeProviderConfig,
): string[] {
  const errors: string[] = [];

  if (config.anthropicAuthToken && !config.anthropicBaseUrl) {
    errors.push('使用 ANTHROPIC_AUTH_TOKEN 时必须配置 ANTHROPIC_BASE_URL');
  }

  if (config.anthropicBaseUrl) {
    try {
      const parsed = new URL(config.anthropicBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push('ANTHROPIC_BASE_URL 必须是 http 或 https 地址');
      }
    } catch {
      errors.push('ANTHROPIC_BASE_URL 格式不正确');
    }
  }

  return errors;
}

export function getClaudeProviderConfig(): ClaudeProviderConfig {
  try {
    const stored = readStoredConfig();
    if (stored) return stored;
  } catch {
    // ignore corrupted file and use env fallback
  }
  return defaultsFromEnv();
}

export function saveClaudeProviderConfig(
  next: Omit<ClaudeProviderConfig, 'updatedAt'>,
  options?: { mode?: ClaudeProviderMode },
): ClaudeProviderConfig {
  const normalized = buildConfig(next, new Date().toISOString());
  const errors = validateClaudeProviderConfig(normalized);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  const mode =
    options?.mode ?? (normalized.anthropicBaseUrl ? 'third_party' : 'official');
  const existing = readStoredState();
  const baseState: ClaudeStoredStateV3Resolved = existing || {
    activeProfileId:
      mode === 'official'
        ? OFFICIAL_CLAUDE_PROFILE_ID
        : DEFAULT_THIRD_PARTY_PROFILE_ID,
    profiles:
      mode === 'official'
        ? []
        : [
            toStoredProfile(
              makeDefaultThirdPartyProfile({
                anthropicBaseUrl: normalized.anthropicBaseUrl,
                anthropicAuthToken: normalized.anthropicAuthToken,
                anthropicApiKey: normalized.anthropicApiKey,
                claudeCodeOauthToken: normalized.claudeCodeOauthToken,
                claudeOAuthCredentials: normalized.claudeOAuthCredentials,
                happyclawModel: normalized.happyclawModel,
                updatedAt: normalized.updatedAt,
              }),
            ),
          ],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: normalized.updatedAt,
    officialCustomEnv: {},
  };

  if (mode === 'official') {
    const officialSecrets = normalizeOfficialSecrets({
      anthropicAuthToken: '',
      anthropicApiKey: normalized.anthropicApiKey,
      claudeCodeOauthToken: normalized.claudeCodeOauthToken,
      claudeOAuthCredentials: normalized.claudeOAuthCredentials,
    });

    writeStoredState({
      ...baseState,
      activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
      officialSecrets,
      officialUpdatedAt: normalized.updatedAt,
    });

    return buildOfficialClaudeProviderConfig(
      officialSecrets,
      normalized.updatedAt,
    );
  }

  const activeId = isOfficialClaudeMode(baseState.activeProfileId)
    ? null
    : baseState.activeProfileId;
  const activeStored =
    (activeId
      ? baseState.profiles.find((item) => item.id === activeId)
      : undefined) || baseState.profiles[0];

  const activeProfile = activeStored
    ? fromStoredProfile(activeStored)
    : makeDefaultThirdPartyProfile(normalized);

  const updatedProfile: ClaudeThirdPartyProfile = {
    ...activeProfile,
    anthropicBaseUrl: normalized.anthropicBaseUrl,
    anthropicAuthToken: normalized.anthropicAuthToken,
    happyclawModel: normalized.happyclawModel,
    updatedAt: normalized.updatedAt,
  };

  const updatedProfiles = baseState.profiles.length
    ? baseState.profiles.map((item) =>
        item.id === updatedProfile.id ? toStoredProfile(updatedProfile) : item,
      )
    : [toStoredProfile(updatedProfile)];

  writeStoredState({
    activeProfileId: updatedProfile.id,
    profiles: updatedProfiles,
    officialSecrets: normalizeOfficialSecrets({
      anthropicAuthToken: '',
      anthropicApiKey: normalized.anthropicApiKey,
      claudeCodeOauthToken: normalized.claudeCodeOauthToken,
      claudeOAuthCredentials: normalized.claudeOAuthCredentials,
    }),
    officialUpdatedAt: normalized.updatedAt,
    officialCustomEnv: baseState.officialCustomEnv,
  });

  return normalized;
}

export function saveClaudeOfficialProviderSecrets(
  next: Pick<
    ClaudeProviderConfig,
    'anthropicApiKey' | 'claudeCodeOauthToken' | 'claudeOAuthCredentials'
  >,
  options?: { activateOfficial?: boolean },
): ClaudeProviderConfig {
  const updatedAt = new Date().toISOString();
  const officialSecrets = normalizeOfficialSecrets({
    anthropicAuthToken: '',
    anthropicApiKey: next.anthropicApiKey,
    claudeCodeOauthToken: next.claudeCodeOauthToken,
    claudeOAuthCredentials: next.claudeOAuthCredentials,
  });

  const existing = readStoredState();
  const baseState: ClaudeStoredStateV3Resolved = existing || {
    activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
    profiles: [],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: null,
    officialCustomEnv: {},
  };

  writeStoredState({
    ...baseState,
    activeProfileId: options?.activateOfficial
      ? OFFICIAL_CLAUDE_PROFILE_ID
      : baseState.activeProfileId,
    officialSecrets,
    officialUpdatedAt: updatedAt,
  });

  return getClaudeProviderConfig();
}

export function listClaudeThirdPartyProfiles(): {
  activeProfileId: string;
  profiles: ClaudeThirdPartyProfile[];
} {
  const state = readStoredState();
  if (!state) {
    const fallback = defaultsFromEnv();
    const profile = makeDefaultThirdPartyProfile(fallback);
    return {
      activeProfileId: profile.id,
      profiles: [profile],
    };
  }

  return {
    activeProfileId: state.activeProfileId,
    profiles: state.profiles.map((item) => fromStoredProfile(item)),
  };
}

export function toPublicClaudeThirdPartyProfile(
  profile: ClaudeThirdPartyProfile,
): ClaudeThirdPartyProfilePublic {
  return {
    id: profile.id,
    name: profile.name,
    anthropicBaseUrl: profile.anthropicBaseUrl,
    happyclawModel: profile.happyclawModel,
    updatedAt: profile.updatedAt,
    hasAnthropicAuthToken: !!profile.anthropicAuthToken,
    anthropicAuthTokenMasked: maskSecret(profile.anthropicAuthToken),
    customEnv: profile.customEnv || {},
  };
}

function randomProfileId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function createClaudeThirdPartyProfile(input: {
  name: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  happyclawModel?: string;
  customEnv?: Record<string, string>;
}): ClaudeThirdPartyProfile {
  const state = readStoredState() || {
    activeProfileId: DEFAULT_THIRD_PARTY_PROFILE_ID,
    profiles: [],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: null,
    officialCustomEnv: {},
  };

  if (state.profiles.length >= MAX_THIRD_PARTY_PROFILES) {
    throw new Error(`最多只能创建 ${MAX_THIRD_PARTY_PROFILES} 个第三方配置`);
  }

  const now = new Date().toISOString();
  const profile: ClaudeThirdPartyProfile = {
    id: randomProfileId(),
    name: normalizeProfileName(input.name),
    anthropicBaseUrl: normalizeBaseUrl(input.anthropicBaseUrl),
    anthropicAuthToken: normalizeSecret(
      input.anthropicAuthToken,
      'anthropicAuthToken',
    ),
    happyclawModel: normalizeModel(input.happyclawModel ?? ''),
    updatedAt: now,
    customEnv: sanitizeCustomEnvMap(input.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: profile.anthropicBaseUrl,
      anthropicAuthToken: profile.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      happyclawModel: profile.happyclawModel,
    },
    now,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    activeProfileId:
      state.profiles.length === 0 ? profile.id : state.activeProfileId,
    profiles: [...state.profiles, toStoredProfile(profile)],
  });

  return profile;
}

export function updateClaudeThirdPartyProfile(
  profileId: string,
  patch: {
    name?: string;
    anthropicBaseUrl?: string;
    happyclawModel?: string;
    customEnv?: Record<string, string>;
  },
): ClaudeThirdPartyProfile {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const current = state.profiles.find((item) => item.id === id);
  if (!current) throw new Error('未找到指定第三方配置');

  const decoded = fromStoredProfile(current);
  const next: ClaudeThirdPartyProfile = {
    ...decoded,
    name:
      patch.name !== undefined
        ? normalizeProfileName(patch.name)
        : decoded.name,
    anthropicBaseUrl:
      patch.anthropicBaseUrl !== undefined
        ? normalizeBaseUrl(patch.anthropicBaseUrl)
        : decoded.anthropicBaseUrl,
    happyclawModel:
      patch.happyclawModel !== undefined
        ? normalizeModel(patch.happyclawModel)
        : decoded.happyclawModel,
    customEnv:
      patch.customEnv !== undefined
        ? sanitizeCustomEnvMap(patch.customEnv, {
            skipReservedClaudeKeys: true,
          })
        : decoded.customEnv,
    updatedAt: new Date().toISOString(),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: next.anthropicBaseUrl,
      anthropicAuthToken: next.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      happyclawModel: next.happyclawModel,
    },
    next.updatedAt,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    profiles: state.profiles.map((item) =>
      item.id === id ? toStoredProfile(next) : item,
    ),
  });

  return next;
}

export function updateClaudeThirdPartyProfileSecret(
  profileId: string,
  patch: {
    anthropicAuthToken?: string;
    clearAnthropicAuthToken?: boolean;
  },
): ClaudeThirdPartyProfile {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const current = state.profiles.find((item) => item.id === id);
  if (!current) throw new Error('未找到指定第三方配置');

  const decoded = fromStoredProfile(current);
  const nextToken =
    typeof patch.anthropicAuthToken === 'string'
      ? normalizeSecret(patch.anthropicAuthToken, 'anthropicAuthToken')
      : patch.clearAnthropicAuthToken
        ? ''
        : decoded.anthropicAuthToken;

  const next: ClaudeThirdPartyProfile = {
    ...decoded,
    anthropicAuthToken: nextToken,
    updatedAt: new Date().toISOString(),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: next.anthropicBaseUrl,
      anthropicAuthToken: next.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      happyclawModel: next.happyclawModel,
    },
    next.updatedAt,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    profiles: state.profiles.map((item) =>
      item.id === id ? toStoredProfile(next) : item,
    ),
  });

  return next;
}

export function activateClaudeThirdPartyProfile(
  profileId: string,
): ClaudeProviderConfig {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const target = state.profiles.find((item) => item.id === id);
  if (!target) throw new Error('未找到指定第三方配置');

  writeStoredState({
    ...state,
    activeProfileId: id,
  });

  return getClaudeProviderConfig();
}

export function deleteClaudeThirdPartyProfile(profileId: string): {
  activeProfileId: string;
  deletedProfileId: string;
} {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  if (!state.profiles.some((item) => item.id === id)) {
    throw new Error('未找到指定第三方配置');
  }
  if (state.profiles.length <= 1) {
    throw new Error('至少需要保留一个第三方配置');
  }

  const profiles = state.profiles.filter((item) => item.id !== id);
  const activeProfileId =
    state.activeProfileId === id ? profiles[0].id : state.activeProfileId;

  writeStoredState({
    ...state,
    activeProfileId,
    profiles,
  });

  return {
    activeProfileId,
    deletedProfileId: id,
  };
}

/** Strip control characters from a value before writing to env file (defense-in-depth) */
function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

/** Convert KEY=value lines to shell-safe format by single-quoting values.
 *  Used when writing env files that are `source`d by bash. */
export function shellQuoteEnvLines(lines: string[]): string[] {
  return lines.map((line) => {
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    // Escape embedded single quotes: ' → '\''
    const quoted = "'" + value.replace(/'/g, "'\\''") + "'";
    return `${key}=${quoted}`;
  });
}

export function buildClaudeEnvLines(config: ClaudeProviderConfig): string[] {
  const lines: string[] = [];

  // When full OAuth credentials exist, authentication is handled by .credentials.json file.
  // Only fall back to CLAUDE_CODE_OAUTH_TOKEN env var for legacy single-token mode.
  if (!config.claudeOAuthCredentials && config.claudeCodeOauthToken) {
    lines.push(
      `CLAUDE_CODE_OAUTH_TOKEN=${sanitizeEnvValue(config.claudeCodeOauthToken)}`,
    );
  }
  if (config.anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY=${sanitizeEnvValue(config.anthropicApiKey)}`);
  }
  if (config.anthropicBaseUrl) {
    lines.push(
      `ANTHROPIC_BASE_URL=${sanitizeEnvValue(config.anthropicBaseUrl)}`,
    );
  }
  if (config.anthropicAuthToken) {
    lines.push(
      `ANTHROPIC_AUTH_TOKEN=${sanitizeEnvValue(config.anthropicAuthToken)}`,
    );
  }
  if (config.happyclawModel) {
    lines.push(`HAPPYCLAW_MODEL=${sanitizeEnvValue(config.happyclawModel)}`);
  }

  const customEnv = getActiveProfileCustomEnv();
  for (const [key, value] of Object.entries(customEnv)) {
    if (RESERVED_CLAUDE_ENV_KEYS.has(key)) continue;
    lines.push(`${key}=${sanitizeEnvValue(value)}`);
  }

  return lines;
}

export function getActiveProfileCustomEnv(): Record<string, string> {
  const state = readStoredState();
  if (!state) return {};

  if (isOfficialClaudeMode(state.activeProfileId)) {
    return sanitizeCustomEnvMap(state.officialCustomEnv || {}, {
      skipReservedClaudeKeys: true,
    });
  }

  const active =
    state.profiles.find((item) => item.id === state.activeProfileId) ||
    state.profiles[0];
  if (!active) return {};

  return sanitizeCustomEnvMap(active.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
}

export function saveOfficialCustomEnv(
  customEnv: Record<string, string>,
): Record<string, string> {
  const sanitized = sanitizeCustomEnvMap(customEnv, {
    skipReservedClaudeKeys: true,
  });
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');
  writeStoredState({
    ...state,
    officialCustomEnv: sanitized,
  });
  return sanitized;
}

export function appendClaudeConfigAudit(
  actor: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  const entry: ClaudeConfigAuditEntry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    changedFields,
    metadata,
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  fs.appendFileSync(
    CLAUDE_CONFIG_AUDIT_FILE,
    `${JSON.stringify(entry)}\n`,
    'utf-8',
  );
}

// ─── Per-container environment config ───────────────────────────

const CONTAINER_ENV_DIR = path.join(DATA_DIR, 'config', 'container-env');

export interface ContainerEnvConfig {
  /** Claude provider overrides — empty string means "use global" */
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  happyclawModel?: string;
  /** Arbitrary extra env vars injected into the container */
  customEnv?: Record<string, string>;
}

export interface ContainerEnvPublicConfig {
  anthropicBaseUrl: string;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  happyclawModel: string;
  customEnv: Record<string, string>;
}

function containerEnvPath(folder: string): string {
  if (folder.includes('..') || folder.includes('/')) {
    throw new Error('Invalid folder name');
  }
  return path.join(CONTAINER_ENV_DIR, `${folder}.json`);
}

export function getContainerEnvConfig(folder: string): ContainerEnvConfig {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      ) as ContainerEnvConfig;
    }
  } catch (err) {
    logger.warn(
      { err, folder },
      'Failed to read container env config, returning defaults',
    );
  }
  return {};
}

export function saveContainerEnvConfig(
  folder: string,
  config: ContainerEnvConfig,
): void {
  // Sanitize all string fields to prevent env injection
  const sanitized: ContainerEnvConfig = { ...config };
  if (sanitized.anthropicBaseUrl)
    sanitized.anthropicBaseUrl = sanitizeEnvValue(sanitized.anthropicBaseUrl);
  if (sanitized.anthropicAuthToken)
    sanitized.anthropicAuthToken = sanitizeEnvValue(
      sanitized.anthropicAuthToken,
    );
  if (sanitized.anthropicApiKey)
    sanitized.anthropicApiKey = sanitizeEnvValue(sanitized.anthropicApiKey);
  if (sanitized.claudeCodeOauthToken)
    sanitized.claudeCodeOauthToken = sanitizeEnvValue(
      sanitized.claudeCodeOauthToken,
    );
  if (sanitized.happyclawModel)
    sanitized.happyclawModel = sanitizeEnvValue(sanitized.happyclawModel);
  if (sanitized.customEnv) {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(sanitized.customEnv)) {
      if (DANGEROUS_ENV_VARS.has(k)) {
        logger.warn(
          { key: k },
          'Rejected dangerous env variable in saveContainerEnvConfig',
        );
        continue;
      }
      cleanEnv[k] = sanitizeEnvValue(v);
    }
    sanitized.customEnv = cleanEnv;
  }

  fs.mkdirSync(CONTAINER_ENV_DIR, { recursive: true });
  const tmp = `${containerEnvPath(folder)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, containerEnvPath(folder));
}

export function deleteContainerEnvConfig(folder: string): void {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function toPublicContainerEnvConfig(
  config: ContainerEnvConfig,
): ContainerEnvPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl || '',
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken || ''),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey || ''),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken || ''),
    happyclawModel: config.happyclawModel || '',
    customEnv: config.customEnv || {},
  };
}

/**
 * Merge global config with per-container overrides.
 * Non-empty per-container fields override the global value.
 */
export function mergeClaudeEnvConfig(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: override.anthropicBaseUrl || global.anthropicBaseUrl,
    anthropicAuthToken:
      override.anthropicAuthToken || global.anthropicAuthToken,
    anthropicApiKey: override.anthropicApiKey || global.anthropicApiKey,
    claudeCodeOauthToken:
      override.claudeCodeOauthToken || global.claudeCodeOauthToken,
    claudeOAuthCredentials:
      override.claudeOAuthCredentials ?? global.claudeOAuthCredentials,
    happyclawModel: override.happyclawModel || global.happyclawModel,
    updatedAt: global.updatedAt,
  };
}

// ─── Registration config (plain JSON, no encryption) ─────────────

const REGISTRATION_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'registration.json',
);

export interface RegistrationConfig {
  allowRegistration: boolean;
  requireInviteCode: boolean;
  updatedAt: string | null;
}

const DEFAULT_REGISTRATION_CONFIG: RegistrationConfig = {
  allowRegistration: true,
  requireInviteCode: true,
  updatedAt: null,
};

export function getRegistrationConfig(): RegistrationConfig {
  try {
    if (!fs.existsSync(REGISTRATION_CONFIG_FILE)) {
      return { ...DEFAULT_REGISTRATION_CONFIG };
    }
    const raw = JSON.parse(
      fs.readFileSync(REGISTRATION_CONFIG_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    return {
      allowRegistration:
        typeof raw.allowRegistration === 'boolean'
          ? raw.allowRegistration
          : true,
      requireInviteCode:
        typeof raw.requireInviteCode === 'boolean'
          ? raw.requireInviteCode
          : true,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read registration config, returning defaults',
    );
    return { ...DEFAULT_REGISTRATION_CONFIG };
  }
}

export function saveRegistrationConfig(
  next: Pick<RegistrationConfig, 'allowRegistration' | 'requireInviteCode'>,
): RegistrationConfig {
  const config: RegistrationConfig = {
    allowRegistration: next.allowRegistration,
    requireInviteCode: next.requireInviteCode,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${REGISTRATION_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, REGISTRATION_CONFIG_FILE);
  return config;
}

/**
 * Build full env lines: merged Claude config + custom env vars.
 */
export function buildContainerEnvLines(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
): string[] {
  const merged = mergeClaudeEnvConfig(global, override);
  const lines = buildClaudeEnvLines(merged);

  // Append custom env vars (with safety sanitization as defense-in-depth)
  if (override.customEnv) {
    for (const [key, value] of Object.entries(override.customEnv)) {
      if (!key || value === undefined) continue;
      if (!ENV_KEY_RE.test(key)) {
        logger.warn(
          { key },
          'Skipping invalid env key in buildContainerEnvLines',
        );
        continue;
      }
      // Block dangerous environment variables
      if (DANGEROUS_ENV_VARS.has(key)) {
        logger.warn(
          { key },
          'Blocked dangerous env variable in buildContainerEnvLines',
        );
        continue;
      }
      // Strip control characters to prevent env injection
      const sanitized = value.replace(/[\r\n\0]/g, '');
      lines.push(`${key}=${sanitized}`);
    }
  }

  return lines;
}

// ─── OAuth credentials file management ────────────────────────────

/**
 * Write .credentials.json to a Claude session directory.
 * Format matches what Claude Code CLI/Agent SDK natively reads.
 */
export function writeCredentialsFile(
  sessionDir: string,
  config: ClaudeProviderConfig,
): void {
  const creds = config.claudeOAuthCredentials;
  if (!creds) return;

  const credentialsData = {
    claudeAiOauth: {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      scopes: creds.scopes,
    },
  };

  const filePath = path.join(sessionDir, '.credentials.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentialsData, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o644,
  });
  fs.renameSync(tmp, filePath);
}

/**
 * Update .credentials.json in all existing session directories + host ~/.claude/
 */
export function updateAllSessionCredentials(
  config: ClaudeProviderConfig,
): void {
  if (!config.claudeOAuthCredentials) return;

  const sessionsDir = path.join(DATA_DIR, 'sessions');
  try {
    if (!fs.existsSync(sessionsDir)) return;
    for (const folder of fs.readdirSync(sessionsDir)) {
      const claudeDir = path.join(sessionsDir, folder, '.claude');
      if (fs.existsSync(claudeDir) && fs.statSync(claudeDir).isDirectory()) {
        try {
          writeCredentialsFile(claudeDir, config);
        } catch (err) {
          logger.warn(
            { err, folder },
            'Failed to write .credentials.json for session',
          );
        }
      }
      // Also update sub-agent session dirs
      const agentsDir = path.join(sessionsDir, folder, 'agents');
      if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
        for (const agentId of fs.readdirSync(agentsDir)) {
          const agentClaudeDir = path.join(agentsDir, agentId, '.claude');
          if (
            fs.existsSync(agentClaudeDir) &&
            fs.statSync(agentClaudeDir).isDirectory()
          ) {
            try {
              writeCredentialsFile(agentClaudeDir, config);
            } catch (err) {
              logger.warn(
                { err, folder, agentId },
                'Failed to write .credentials.json for agent session',
              );
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to update session credentials');
  }

  // Host mode uses CLAUDE_CONFIG_DIR=data/sessions/{folder}/.claude for isolation,
  // so we must NOT touch ~/.claude/.credentials.json to avoid interfering with
  // the user's local Claude Code installation.
}

// ─── Local Claude Code detection ──────────────────────────────────

export interface LocalClaudeCodeStatus {
  detected: boolean;
  hasCredentials: boolean;
  expiresAt: number | null;
  accessTokenMasked: string | null;
}

/**
 * Read and parse OAuth credentials from ~/.claude/.credentials.json.
 * Returns the raw oauth object with accessToken, refreshToken, expiresAt, scopes,
 * or null if the file is missing / invalid / incomplete.
 */
function readLocalOAuthCredentials(): {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scopes?: string[];
} | null {
  const homeDir = process.env.HOME || '/root';
  const credFile = path.join(homeDir, '.claude', '.credentials.json');

  try {
    if (!fs.existsSync(credFile)) return null;

    const content = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
    const oauth = content?.claudeAiOauth;

    if (oauth?.accessToken && oauth?.refreshToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt:
          typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
        scopes: Array.isArray(oauth.scopes) ? oauth.scopes : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect if the host machine has a valid ~/.claude/.credentials.json
 * (i.e. user has logged into Claude Code locally).
 */
export function detectLocalClaudeCode(): LocalClaudeCodeStatus {
  const oauth = readLocalOAuthCredentials();

  if (oauth) {
    return {
      detected: true,
      hasCredentials: true,
      expiresAt: oauth.expiresAt ?? null,
      accessTokenMasked: maskSecret(oauth.accessToken),
    };
  }

  // Check if the file exists at all (detected but no valid credentials)
  const homeDir = process.env.HOME || '/root';
  const credFile = path.join(homeDir, '.claude', '.credentials.json');
  const fileExists = fs.existsSync(credFile);

  return {
    detected: fileExists,
    hasCredentials: false,
    expiresAt: null,
    accessTokenMasked: null,
  };
}

/**
 * Read local ~/.claude/.credentials.json and return parsed OAuth credentials.
 * Returns null if not found or invalid.
 */
export function importLocalClaudeCredentials(): ClaudeOAuthCredentials | null {
  const oauth = readLocalOAuthCredentials();
  if (!oauth) return null;

  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt ?? Date.now() + 8 * 3600_000,
    scopes: oauth.scopes ?? [],
  };
}

// ─── Appearance config (plain JSON, no encryption) ────────────────

const APPEARANCE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'appearance.json');

export interface AppearanceConfig {
  appName: string;
  aiName: string;
  aiAvatarEmoji: string;
  aiAvatarColor: string;
}

const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  appName: ASSISTANT_NAME,
  aiName: ASSISTANT_NAME,
  aiAvatarEmoji: '\u{1F431}',
  aiAvatarColor: '#0d9488',
};

export function getAppearanceConfig(): AppearanceConfig {
  try {
    if (!fs.existsSync(APPEARANCE_CONFIG_FILE)) {
      return { ...DEFAULT_APPEARANCE_CONFIG };
    }
    const raw = JSON.parse(
      fs.readFileSync(APPEARANCE_CONFIG_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    return {
      appName:
        typeof raw.appName === 'string' && raw.appName
          ? raw.appName
          : DEFAULT_APPEARANCE_CONFIG.appName,
      aiName:
        typeof raw.aiName === 'string' && raw.aiName
          ? raw.aiName
          : DEFAULT_APPEARANCE_CONFIG.aiName,
      aiAvatarEmoji:
        typeof raw.aiAvatarEmoji === 'string' && raw.aiAvatarEmoji
          ? raw.aiAvatarEmoji
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarEmoji,
      aiAvatarColor:
        typeof raw.aiAvatarColor === 'string' && raw.aiAvatarColor
          ? raw.aiAvatarColor
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarColor,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read appearance config, returning defaults',
    );
    return { ...DEFAULT_APPEARANCE_CONFIG };
  }
}

export function saveAppearanceConfig(
  next: Partial<Pick<AppearanceConfig, 'appName'>> &
    Omit<AppearanceConfig, 'appName'>,
): AppearanceConfig {
  const existing = getAppearanceConfig();
  const config = {
    appName: next.appName || existing.appName,
    aiName: next.aiName,
    aiAvatarEmoji: next.aiAvatarEmoji,
    aiAvatarColor: next.aiAvatarColor,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${APPEARANCE_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, APPEARANCE_CONFIG_FILE);
  return {
    appName: config.appName,
    aiName: config.aiName,
    aiAvatarEmoji: config.aiAvatarEmoji,
    aiAvatarColor: config.aiAvatarColor,
  };
}

// ─── Per-user IM config (AES-256-GCM encrypted) ─────────────────

const USER_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'user-im');

export interface UserFeishuConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserTelegramConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserQQConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

interface StoredQQProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface QQSecretPayload {
  appSecret: string;
}

function userImDir(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid userId');
  }
  return path.join(USER_IM_CONFIG_DIR, userId);
}

export function getUserFeishuConfig(userId: string): UserFeishuConfig | null {
  const filePath = path.join(userImDir(userId), 'feishu.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredFeishuProviderConfigV1;
    const secret = decryptFeishuSecret(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Feishu config');
    return null;
  }
}

export function saveUserFeishuConfig(
  userId: string,
  next: Omit<UserFeishuConfig, 'updatedAt'>,
): UserFeishuConfig {
  const normalized: UserFeishuConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptFeishuSecret({ appSecret: normalized.appSecret }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'feishu.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function getUserTelegramConfig(
  userId: string,
): UserTelegramConfig | null {
  const filePath = path.join(userImDir(userId), 'telegram.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredTelegramProviderConfigV1;
    const secret = decryptTelegramSecret(stored.secret);
    return {
      botToken: secret.botToken,
      proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Telegram config');
    return null;
  }
}

export function saveUserTelegramConfig(
  userId: string,
  next: Omit<UserTelegramConfig, 'updatedAt'>,
): UserTelegramConfig {
  const normalizedProxyUrl = next.proxyUrl
    ? normalizeTelegramProxyUrl(next.proxyUrl)
    : '';
  const normalized: UserTelegramConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptTelegramSecret({ botToken: normalized.botToken }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'telegram.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

// ========== QQ User IM Config ==========

function encryptQQSecret(payload: QQSecretPayload): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptQQSecret(secrets: EncryptedSecrets): QQSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  return {
    appSecret: normalizeSecret(parsed.appSecret ?? '', 'appSecret'),
  };
}

export function getUserQQConfig(userId: string): UserQQConfig | null {
  const filePath = path.join(userImDir(userId), 'qq.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredQQProviderConfigV1;
    const secret = decryptQQSecret(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user QQ config');
    return null;
  }
}

export function saveUserQQConfig(
  userId: string,
  next: Omit<UserQQConfig, 'updatedAt'>,
): UserQQConfig {
  const normalized: UserQQConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredQQProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptQQSecret({ appSecret: normalized.appSecret }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'qq.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

// ─── System settings (plain JSON, no encryption) ─────────────────

const SYSTEM_SETTINGS_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'system-settings.json',
);

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
}

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  containerTimeout: 1800000,
  idleTimeout: 1800000,
  containerMaxOutputSize: 10485760,
  maxConcurrentContainers: 20,
  maxConcurrentHostProcesses: 5,
  maxLoginAttempts: 5,
  loginLockoutMinutes: 15,
  maxConcurrentScripts: 10,
  scriptTimeout: 60000,
};

function parseIntEnv(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = parseInt(envVar, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// In-memory cache: avoid synchronous file I/O on hot paths (stdout data handler, queue capacity check)
let _settingsCache: SystemSettings | null = null;
let _settingsMtimeMs = 0;

function readSystemSettingsFromFile(): SystemSettings | null {
  if (!fs.existsSync(SYSTEM_SETTINGS_FILE)) return null;
  const raw = JSON.parse(
    fs.readFileSync(SYSTEM_SETTINGS_FILE, 'utf-8'),
  ) as Record<string, unknown>;
  return {
    containerTimeout:
      typeof raw.containerTimeout === 'number' && raw.containerTimeout > 0
        ? raw.containerTimeout
        : DEFAULT_SYSTEM_SETTINGS.containerTimeout,
    idleTimeout:
      typeof raw.idleTimeout === 'number' && raw.idleTimeout > 0
        ? raw.idleTimeout
        : DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    containerMaxOutputSize:
      typeof raw.containerMaxOutputSize === 'number' &&
      raw.containerMaxOutputSize > 0
        ? raw.containerMaxOutputSize
        : DEFAULT_SYSTEM_SETTINGS.containerMaxOutputSize,
    maxConcurrentContainers:
      typeof raw.maxConcurrentContainers === 'number' &&
      raw.maxConcurrentContainers > 0
        ? raw.maxConcurrentContainers
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentContainers,
    maxConcurrentHostProcesses:
      typeof raw.maxConcurrentHostProcesses === 'number' &&
      raw.maxConcurrentHostProcesses > 0
        ? raw.maxConcurrentHostProcesses
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentHostProcesses,
    maxLoginAttempts:
      typeof raw.maxLoginAttempts === 'number' && raw.maxLoginAttempts > 0
        ? raw.maxLoginAttempts
        : DEFAULT_SYSTEM_SETTINGS.maxLoginAttempts,
    loginLockoutMinutes:
      typeof raw.loginLockoutMinutes === 'number' && raw.loginLockoutMinutes > 0
        ? raw.loginLockoutMinutes
        : DEFAULT_SYSTEM_SETTINGS.loginLockoutMinutes,
    maxConcurrentScripts:
      typeof raw.maxConcurrentScripts === 'number' &&
      raw.maxConcurrentScripts > 0
        ? raw.maxConcurrentScripts
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    scriptTimeout:
      typeof raw.scriptTimeout === 'number' && raw.scriptTimeout > 0
        ? raw.scriptTimeout
        : DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
  };
}

function buildEnvFallbackSettings(): SystemSettings {
  return {
    containerTimeout: parseIntEnv(
      process.env.CONTAINER_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.containerTimeout,
    ),
    idleTimeout: parseIntEnv(
      process.env.IDLE_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    ),
    containerMaxOutputSize: parseIntEnv(
      process.env.CONTAINER_MAX_OUTPUT_SIZE,
      DEFAULT_SYSTEM_SETTINGS.containerMaxOutputSize,
    ),
    maxConcurrentContainers: parseIntEnv(
      process.env.MAX_CONCURRENT_CONTAINERS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentContainers,
    ),
    maxConcurrentHostProcesses: parseIntEnv(
      process.env.MAX_CONCURRENT_HOST_PROCESSES,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentHostProcesses,
    ),
    maxLoginAttempts: parseIntEnv(
      process.env.MAX_LOGIN_ATTEMPTS,
      DEFAULT_SYSTEM_SETTINGS.maxLoginAttempts,
    ),
    loginLockoutMinutes: parseIntEnv(
      process.env.LOGIN_LOCKOUT_MINUTES,
      DEFAULT_SYSTEM_SETTINGS.loginLockoutMinutes,
    ),
    maxConcurrentScripts: parseIntEnv(
      process.env.MAX_CONCURRENT_SCRIPTS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    ),
    scriptTimeout: parseIntEnv(
      process.env.SCRIPT_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
    ),
  };
}

export function getSystemSettings(): SystemSettings {
  // Fast path: return cached value if file hasn't changed
  try {
    if (_settingsCache) {
      if (!fs.existsSync(SYSTEM_SETTINGS_FILE)) return _settingsCache;
      const mtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      if (mtimeMs === _settingsMtimeMs) return _settingsCache;
    }
  } catch {
    // stat failed — fall through to full read
  }

  // 1. Try reading from file
  try {
    if (fs.existsSync(SYSTEM_SETTINGS_FILE)) {
      const settings = readSystemSettingsFromFile();
      if (settings) {
        _settingsCache = settings;
        try {
          _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
        } catch {
          /* ignore */
        }
        return settings;
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read system settings, falling back to env/defaults',
    );
  }

  // 2. Fall back to env vars, then hardcoded defaults
  const settings = buildEnvFallbackSettings();
  _settingsCache = settings;
  _settingsMtimeMs = 0; // no file — will re-check on next call
  return settings;
}

export function saveSystemSettings(
  partial: Partial<SystemSettings>,
): SystemSettings {
  const existing = getSystemSettings();
  const merged: SystemSettings = { ...existing, ...partial };

  // Range validation
  if (merged.containerTimeout < 60000) merged.containerTimeout = 60000; // min 1 min
  if (merged.containerTimeout > 86400000) merged.containerTimeout = 86400000; // max 24 hours
  if (merged.idleTimeout < 60000) merged.idleTimeout = 60000;
  if (merged.idleTimeout > 86400000) merged.idleTimeout = 86400000;
  if (merged.containerMaxOutputSize < 1048576)
    merged.containerMaxOutputSize = 1048576; // min 1MB
  if (merged.containerMaxOutputSize > 104857600)
    merged.containerMaxOutputSize = 104857600; // max 100MB
  if (merged.maxConcurrentContainers < 1) merged.maxConcurrentContainers = 1;
  if (merged.maxConcurrentContainers > 100)
    merged.maxConcurrentContainers = 100;
  if (merged.maxConcurrentHostProcesses < 1)
    merged.maxConcurrentHostProcesses = 1;
  if (merged.maxConcurrentHostProcesses > 50)
    merged.maxConcurrentHostProcesses = 50;
  if (merged.maxLoginAttempts < 1) merged.maxLoginAttempts = 1;
  if (merged.maxLoginAttempts > 100) merged.maxLoginAttempts = 100;
  if (merged.loginLockoutMinutes < 1) merged.loginLockoutMinutes = 1;
  if (merged.loginLockoutMinutes > 1440) merged.loginLockoutMinutes = 1440; // max 24 hours
  if (merged.maxConcurrentScripts < 1) merged.maxConcurrentScripts = 1;
  if (merged.maxConcurrentScripts > 50) merged.maxConcurrentScripts = 50;
  if (merged.scriptTimeout < 5000) merged.scriptTimeout = 5000; // min 5s
  if (merged.scriptTimeout > 600000) merged.scriptTimeout = 600000; // max 10 min

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${SYSTEM_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, SYSTEM_SETTINGS_FILE);

  // Update in-memory cache immediately
  _settingsCache = merged;
  try {
    _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
  } catch {
    /* ignore */
  }

  return merged;
}
