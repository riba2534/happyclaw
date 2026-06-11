import { describe, expect, test } from 'vitest';
import {
  redactInlineSecrets,
  summarizeToolInput,
} from '../container/agent-runner/src/utils.js';

describe('redactInlineSecrets', () => {
  describe('OAuth bearer tokens', () => {
    test.each([
      ['Bearer abc123abc123abc123', /Bearer \[REDACTED\]/],
      ['bearer xyz789xyz789xyz789', /Bearer \[REDACTED\]/],
      ['BEARER ABC123ABC123ABC123', /Bearer \[REDACTED\]/, 'all-caps (R3 fix)'],
      ['Authorization: Bearer eyJhbGc.eyJzdWI.SflKxw', /\[REDACTED\]/],
    ])('%s', (input, expected) => {
      expect(redactInlineSecrets(input)).toMatch(expected);
    });
  });

  describe('DSN basic auth (covers postgres / mongodb / redis / mysql / ftp / ssh / git — R3 fix)', () => {
    test.each([
      ['psql postgresql://user:supersecret@db.example.com:5432/prod'],
      ['mongosh mongodb+srv://admin:hunter2@cluster0.mongo.net/db'],
      ['redis-cli redis://default:apw@cache.example.com:6379'],
      ['mysql --uri mysql://root:rootpw@db:3306'],
      ['curl ftp://user:pass@ftp.example.com/file'],
      ['git clone https://user:tokenABC@github.com/owner/repo.git'],
    ])('redacts password in: %s', (input) => {
      const out = redactInlineSecrets(input);
      expect(out).not.toMatch(/supersecret|hunter2|apw|rootpw|pass|tokenABC/);
      expect(out).toMatch(/\[REDACTED\]/);
    });
  });

  describe('key=value patterns', () => {
    test('redacts api_key= / api-key= / x-api-key=', () => {
      expect(redactInlineSecrets('api_key=mysecret123')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('api-key=mysecret123')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('x-api-key=foo')).toMatch(/\[REDACTED\]/);
    });

    test('redacts authorization= / cookie= / password= / token=', () => {
      expect(redactInlineSecrets('authorization=Bearer xyz')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('cookie=sid=abc123')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('password=hunter2')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('token=mysecret123')).toMatch(/\[REDACTED\]/);
    });

    test('redacts GH_TOKEN / NPM_TOKEN / AUTH_TOKEN suffix forms (R3 fix)', () => {
      expect(redactInlineSecrets('GH_TOKEN=ghp_abcdefghij')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('NPM_TOKEN=npm_xxxxxxxxxx')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('AUTH_TOKEN=secretvalue')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('access_token=foo123')).toMatch(/\[REDACTED\]/);
      expect(redactInlineSecrets('refresh_token=bar123')).toMatch(/\[REDACTED\]/);
    });
  });

  describe('CLI argument forms (R3 fix)', () => {
    test('redacts --token <value> / --api-key <value>', () => {
      expect(redactInlineSecrets('curl --token mysecret123 https://api.example.com')).toMatch(/--token \[REDACTED\]/);
      expect(redactInlineSecrets('--api-key abc123abc')).toMatch(/--api-key \[REDACTED\]/);
      expect(redactInlineSecrets('--password hunter2')).toMatch(/--password \[REDACTED\]/);
    });
  });

  describe('vendor token prefixes', () => {
    test.each([
      ['sk-ant-abcdefghijklmnopqrst', 'Anthropic'],
      ['sk-1234567890abcdefghij', 'OpenAI'],
      ['ghp_1234567890abcdefghij1234567890', 'GitHub classic PAT'],
      ['gho_1234567890abcdefghij1234567890', 'GitHub OAuth'],
      ['ghs_1234567890abcdefghij1234567890', 'GitHub server-to-server'],
      ['github_pat_11ABCDEFGHIJ_thisisaveryLongTokenStringHere', 'GitHub fine-grained PAT (R3 fix)'],
      ['glpat-xxxxxxxxxxxxxxxxxxxx', 'GitLab PAT (R3 fix)'],
      ['xoxb-1234567890-abcde-fghij', 'Slack bot token'],
      ['xoxe-1234567890-abcde-fghij', 'Slack new format (R3 fix)'],
      ['AKIAIOSFODNN7EXAMPLE', 'AWS access key'],
      ['ASIAIOSFODNN7EXAMPLE', 'AWS temporary credentials (R3 fix)'],
      ['AIzaSyD9HPxxxxxxxxxxxxxxxxxxxxxxxxxxx_X', 'Google API key (R3 fix, 35 chars after AIza)'],
      // Stripe / SendGrid live-key shapes — split via concat so GitHub
      // secret-scanning push protection doesn't false-positive on test fixtures.
      ['sk_li' + 've_51ABCxxxxxxxxxxxxxxxxxxxx', 'Stripe live (R3 fix)'],
      ['sk_te' + 'st_51ABCxxxxxxxxxxxxxxxxxxxx', 'Stripe test'],
      ['SG' + '.abcdefghijklmnop.xxxxxxxxxxxxxxxx', 'SendGrid (R3 fix)'],
      ['npm_abcdefghijklmnopqrstuvwxyz0123456789ab', 'npm publish token (R3 fix)'],
    ])('redacts %s (%s)', (token) => {
      const input = `running with token ${token} now`;
      const out = redactInlineSecrets(input);
      expect(out).toContain('[REDACTED]');
      expect(out).not.toContain(token);
    });
  });

  describe('PEM private keys (R3 fix)', () => {
    test('redacts entire PEM block', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const out = redactInlineSecrets(pem);
      expect(out).toBe('[REDACTED PRIVATE KEY]');
    });

    test('redacts ED25519 / EC keys too', () => {
      const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----';
      expect(redactInlineSecrets(pem)).toBe('[REDACTED PRIVATE KEY]');
    });
  });

  describe('32KB short-circuit (R3 ReDoS protection)', () => {
    test('returns [REDACTED LARGE INPUT] for input > 32KB', () => {
      const huge = 'a'.repeat(33 * 1024);
      expect(redactInlineSecrets(huge)).toBe('[REDACTED LARGE INPUT]');
    });

    test('does not short-circuit for input under 32KB', () => {
      const big = 'safe content '.repeat(2000); // ~26KB
      expect(big.length).toBeLessThan(32 * 1024);
      const out = redactInlineSecrets(big);
      expect(out).not.toBe('[REDACTED LARGE INPUT]');
    });

    test('regex on 50k underscore-suffixed-token-like repeats finishes quickly (no ReDoS)', () => {
      // Previous lazy-prefix pattern was O(n^2) on this input.
      // This test guards against accidental re-introduction.
      const s = '_authToken'.repeat(3000); // ~30KB, under short-circuit threshold
      const start = Date.now();
      redactInlineSecrets(s);
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(500); // generous; real-world should be <50ms
    });
  });

  describe('preserves benign content', () => {
    test('unchanged for plain text', () => {
      expect(redactInlineSecrets('hello world')).toBe('hello world');
      expect(redactInlineSecrets('echo "good morning"')).toBe('echo "good morning"');
    });

    test('does not over-match generic words', () => {
      expect(redactInlineSecrets('let me login')).toBe('let me login');
      expect(redactInlineSecrets('password documentation')).toBe('password documentation');
    });
  });
});

describe('summarizeToolInput (integrates redactInlineSecrets)', () => {
  test('redacts in command field', () => {
    const out = summarizeToolInput({
      command: 'curl -H "Authorization: Bearer eyJhbGc.eyJzdWI.SflKxw" https://api',
    });
    expect(out).toMatch(/\[REDACTED\]/);
    expect(out).not.toMatch(/eyJ.+SflKxw/);
  });

  test('redacts in url field', () => {
    const out = summarizeToolInput({
      url: 'https://api.example.com/?api_key=mysecret123abc',
    });
    expect(out).toMatch(/\[REDACTED\]/);
    expect(out).not.toContain('mysecret123abc');
  });

  test('redacts string-form input', () => {
    const out = summarizeToolInput('Bearer eyJhbGc.eyJzdWI.SflKxw and more');
    expect(out).toMatch(/\[REDACTED\]/);
  });

  test('does not crash on null / undefined / number', () => {
    expect(summarizeToolInput(null)).toBeUndefined();
    expect(summarizeToolInput(undefined)).toBeUndefined();
    expect(summarizeToolInput(42)).toBeUndefined();
  });

  test('hits LARGE INPUT short-circuit on huge command', () => {
    const out = summarizeToolInput({ command: 'a'.repeat(40 * 1024) });
    expect(out).toContain('[REDACTED LARGE INPUT]');
  });
});
