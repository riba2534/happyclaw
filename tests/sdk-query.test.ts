import { beforeEach, describe, expect, test, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const providerConfig = vi.hoisted(() => ({
  current: { anthropicModel: 'test-model' } as Record<string, string>,
  providers: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));
vi.mock('../src/runtime-config.js', () => ({
  buildClaudeEnvLines: (config: Record<string, string>) =>
    config.anthropicBaseUrl
      ? [
          `ANTHROPIC_BASE_URL=${config.anthropicBaseUrl}`,
          `ANTHROPIC_API_KEY=${config.anthropicAuthToken}`,
        ]
      : ['ANTHROPIC_API_KEY=test-key', 'CLAUDE_CODE_EFFORT_LEVEL=max'],
  clearInheritedClaudeProviderEnv: () => {},
  getClaudeProviderConfig: () => providerConfig.current,
  getProviders: () => providerConfig.providers,
  updateProviderCodexOAuthCredentialsIfCurrent: vi.fn(),
  setProviderCodexOAuthRefreshErrorIfCurrent: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

const { sdkQuery } = await import('../src/sdk-query.js');
const { resolveCodexGatewayToken } =
  await import('../src/codex-gateway/runner-tokens.js');
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');

function successfulConversation(result: string, isError = false) {
  return (async function* () {
    yield { type: 'result', subtype: 'success', result, is_error: isError };
  })();
}

beforeEach(() => {
  query.mockReset();
  providerConfig.current = { anthropicModel: 'test-model' };
  providerConfig.providers = [];
});

describe('sdkQuery', () => {
  test('runs one-turn text queries without exposing tools or filesystem settings', async () => {
    query.mockReturnValue(successfulConversation(' generated response '));

    await expect(sdkQuery('generate a profile')).resolves.toBe(
      'generated response',
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toMatchObject({
      prompt: 'generate a profile',
      options: {
        model: 'test-model',
        maxTurns: 2,
        tools: [],
        skills: [],
        settingSources: [],
        allowedTools: [],
        persistSession: false,
        thinking: { type: 'disabled' },
        effort: 'low',
      },
    });
    const env = query.mock.calls[0][0].options.env;
    expect(env.ANTHROPIC_API_KEY).toBe('test-key');
    expect(env).not.toHaveProperty('CLAUDE_CODE_EFFORT_LEVEL');
  });

  test("without a caller's model, the global connection's background model runs", async () => {
    providerConfig.current = {
      anthropicModel: 'big-model',
      roles: { smallFast: 'small-model' },
    } as never;
    query.mockReturnValue(successfulConversation('title'));
    await sdkQuery('generate a title');
    expect(query.mock.calls[0][0].options.model).toBe('small-model');
    // A caller's model (RECALL_MODEL) still wins.
    query.mockReturnValue(successfulConversation('title'));
    await sdkQuery('recall', { model: 'recall-model' });
    expect(query.mock.calls[1][0].options.model).toBe('recall-model');
    // No background model: the connection's own, as before.
    providerConfig.current = { anthropicModel: 'big-model' };
    query.mockReturnValue(successfulConversation('title'));
    await sdkQuery('generate a title');
    expect(query.mock.calls[2][0].options.model).toBe('big-model');
  });

  test('never returns the API error text of an is_error result', async () => {
    query.mockReturnValue(
      successfulConversation('API Error: 401 invalid x-api-key', true),
    );
    await expect(sdkQuery('generate a title')).resolves.toBeNull();
  });

  test('a Codex provider gets a loopback gateway URL and a token scoped to the query', async () => {
    providerConfig.current = {
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicAuthToken: 'stored-identifier',
      anthropicModel: 'gpt-6-sol',
    };
    providerConfig.providers = [
      {
        id: 'codex-provider',
        anthropicAuthToken: 'stored-identifier',
        codexOAuthCredentials: { accessToken: 'upstream' },
      },
    ];
    let liveDuringQuery: unknown;
    let token = '';
    query.mockImplementation(({ options }) => {
      token = options.env.ANTHROPIC_API_KEY;
      liveDuringQuery = resolveCodexGatewayToken(token);
      expect(options.env.ANTHROPIC_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/gateway\/chatgpt$/,
      );
      expect(options.env.NO_PROXY).toContain('127.0.0.1');
      return successfulConversation('title');
    });
    await expect(sdkQuery('generate a title')).resolves.toBe('title');
    expect(token).toMatch(/^hcgw_/);
    expect(liveDuringQuery).toMatchObject({
      providerId: 'codex-provider',
      owner: { kind: 'sdk-query' },
    });
    expect(resolveCodexGatewayToken(token)).toBeNull();
  });
});
