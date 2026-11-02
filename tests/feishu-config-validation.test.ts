import { describe, it, expect } from 'vitest';
import { FeishuConfigSchema } from '../src/schemas.js';
import { testFeishuCredentials } from '../src/feishu-connectivity.js';

describe('FeishuConfigSchema appId validation', () => {
  it('accepts valid Feishu appId format', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: 'cli_a94258083b789cb3',
      appSecret: 'secret-placeholder',
      enabled: true,
    });
    expect(res.success).toBe(true);
  });

  it('accepts another valid appId variant', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: 'cli_aa83c54c96b8dbd0',
      enabled: false,
    });
    expect(res.success).toBe(true);
  });

  it('accepts empty string appId (partial update)', () => {
    // 用户只更新 enabled / appSecret,不带 appId,UI 提交空串是合法路径
    const res = FeishuConfigSchema.safeParse({
      appId: '',
      enabled: false,
    });
    expect(res.success).toBe(true);
  });

  it('rejects username-shaped appId (historical bug case)', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: 'waimoon',
      appSecret: 'x',
      enabled: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects phone-number-shaped appId (historical bug case)', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: '18058136600',
      appSecret: 'x',
      enabled: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects short string without cli_ prefix', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: 'ynn',
      enabled: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects uppercase letters in appId', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: 'cli_AA83C54C96B8DBD0',
      enabled: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects cli_ alone without payload', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: 'cli_',
      enabled: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects special characters in appId', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: 'cli_abc-123',
      enabled: true,
    });
    expect(res.success).toBe(false);
  });

  it('accepts appId with leading/trailing whitespace (will be trimmed)', () => {
    // per PR #572 review minor: 粘贴带空白的合法 appId 应通过 schema
    // (refine 内 trim 后再正则匹配,与 routes 层的 trim() 行为对齐)
    const res = FeishuConfigSchema.safeParse({
      appId: '  cli_aab0831c21b9dcc2  ',
      appSecret: 'x',
      enabled: true,
    });
    expect(res.success).toBe(true);
  });

  it('still rejects whitespace-padded invalid appId', () => {
    const res = FeishuConfigSchema.safeParse({
      appId: '  waimoon  ',
      enabled: true,
    });
    expect(res.success).toBe(false);
  });
});

describe('testFeishuCredentials', () => {
  it('returns ok when endpoint responds with code 0 and token', async () => {
    const fakeEndpoint = 'http://127.0.0.1:0/stub'; // never reached, mocked via fetch override
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          tenant_access_token: 't-stub',
          expire: 7200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    try {
      const res = await testFeishuCredentials(
        'cli_aa83c54c96b8dbd0',
        'secret',
        {
          endpoint: fakeEndpoint,
        },
      );
      expect(res.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns error code+message when API rejects credentials', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 99991663,
          msg: 'invalid app_id or app_secret',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    try {
      const res = await testFeishuCredentials('cli_aa83c54c96b8dbd0', 'wrong', {
        endpoint: 'http://127.0.0.1:0/stub',
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe(99991663);
      expect(res.errorMessage).toContain('invalid');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns failure on HTTP non-2xx', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('Internal Server Error', { status: 500 });
    try {
      const res = await testFeishuCredentials('cli_aa83c54c96b8dbd0', 'x', {
        endpoint: 'http://127.0.0.1:0/stub',
      });
      expect(res.ok).toBe(false);
      expect(res.errorMessage).toContain('500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns failure with timeout message when aborted', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, init: any) => {
      // 模拟一个不会 resolve 的请求,等待 controller.abort()
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    try {
      const res = await testFeishuCredentials('cli_aa83c54c96b8dbd0', 'x', {
        endpoint: 'http://127.0.0.1:0/stub',
        timeoutMs: 50,
      });
      expect(res.ok).toBe(false);
      expect(res.errorMessage).toContain('timed out');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
