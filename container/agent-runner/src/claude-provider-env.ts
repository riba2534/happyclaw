/**
 * The Claude Code environment HappyClaw owns on every run (names from Claude
 * CLI 2.1.296): which backend serves the requests, where they go, who they
 * authenticate as, which model each tier runs, and the session's effort,
 * compaction and context. HappyClaw sets these from the bound connection and
 * the session's choices. So they are never taken from an inherited shell or
 * the admin's settings layer, and the Runner pins the ones it sets above
 * every settings file.
 *
 * Network configuration (HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS) is not
 * listed: it routes no credential to another provider, and a deployment may
 * need it. General-purpose cloud credentials (AWS_PROFILE,
 * AWS_ACCESS_KEY_ID, GOOGLE_APPLICATION_CREDENTIALS) are not listed either:
 * they reach no provider while every switch below is off, and the agent's
 * own tools use them.
 *
 * Copied by scripts/sync-stream-event.sh to the backend and the Runner.
 */

/** Switches that pick the backend. '0' turns each off (verified on 2.1.296). */
export const CLAUDE_BACKEND_SWITCH_ENV_KEYS: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
];

/** Endpoints, credentials and model tiers. */
export const CLAUDE_PROVIDER_ROUTING_ENV_KEYS: readonly string[] = [
  // Where the requests go.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  // Who they authenticate as.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  // Which model each tier runs.
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/**
 * The session's effort, compaction, context and reply limit, resolved per
 * run (the reply limit from the models' declarations or the connection's
 * own env).
 */
export const CLAUDE_SESSION_TUNING_ENV_KEYS: readonly string[] = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
];

/** Every environment key above. */
export const HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS: readonly string[] = [
  ...CLAUDE_BACKEND_SWITCH_ENV_KEYS,
  ...CLAUDE_PROVIDER_ROUTING_ENV_KEYS,
  ...CLAUDE_SESSION_TUNING_ENV_KEYS,
];

/** Top-level settings that run a command to obtain credentials. */
export const CLAUDE_CREDENTIAL_SETTING_KEYS: readonly string[] = [
  'apiKeyHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'gcpAuthRefresh',
];
