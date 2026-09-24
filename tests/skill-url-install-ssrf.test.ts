import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lookupMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

const { validateSafeHttpsUrl } = await import('../src/url-safety.js');
const {
  assertSafeSkillInstallUrl,
  resolveSkillUrlGitInstall,
  installSkillUrlViaPinnedGit,
  isAllowedSkillUrlGitHost,
} = await import('../src/skill-import-service.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsRoutePath = path.join(here, '../src/routes/skills.ts');
const workspaceRoutePath = path.join(here, '../src/routes/workspace-config.ts');

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '20.205.243.166', family: 4 }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Pre-fix gate: literal HTTPS allowlist only (what both entrypoints did). */
function legacyAllowlistOnly(pkg: string): string | null {
  return validateSafeHttpsUrl(pkg);
}

describe('Batch-283 UF-1 skill URL install SSRF leftover', () => {
  describe('fail baseline: validateSafeHttpsUrl alone cannot stop rebinding', () => {
    test('literal allowlist accepts public hostname that resolves to link-local', async () => {
      lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      const url = 'https://attacker-rebinder.example/skill';
      // Pre-fix behavior: only validateSafeHttpsUrl — passes, then npx would fetch.
      expect(legacyAllowlistOnly(url)).toBeNull();
      // Post-fix: resolve + GitHub allowlist must refuse.
      await expect(assertSafeSkillInstallUrl(url)).rejects.toThrow(
        /private or link-local/,
      );
      await expect(resolveSkillUrlGitInstall(url)).rejects.toThrow(
        /private or link-local|limited to GitHub/,
      );
    });

    test('literal allowlist accepts non-GitHub HTTPS that a redirect-following fetcher would chase', async () => {
      lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const url = 'https://evil-public.example/skill-redirect';
      expect(legacyAllowlistOnly(url)).toBeNull();
      await expect(resolveSkillUrlGitInstall(url)).rejects.toThrow(
        /limited to GitHub HTTPS repositories/,
      );
    });
  });

  describe('assertSafeSkillInstallUrl + resolveSkillUrlGitInstall', () => {
    test('rejects literal private / link-local skill URLs', async () => {
      await expect(
        assertSafeSkillInstallUrl('https://169.254.169.254/latest/meta-data/'),
      ).rejects.toThrow(/Refused skill URL/);
      await expect(
        resolveSkillUrlGitInstall('https://127.0.0.1/skills.git'),
      ).rejects.toThrow(/Refused skill URL/);
    });

    test('rejects credentialed URLs', async () => {
      await expect(
        assertSafeSkillInstallUrl('https://user:pass@github.com/owner/repo'),
      ).rejects.toThrow(/credentials/);
    });

    test('rejects GitHub hostname when DNS resolves to private address', async () => {
      lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        resolveSkillUrlGitInstall('https://github.com/owner/repo'),
      ).rejects.toThrow(/private or link-local/);
    });

    test('parses allowlisted GitHub repository and tree URLs', async () => {
      await expect(
        resolveSkillUrlGitInstall('https://github.com/owner/repo'),
      ).resolves.toEqual({
        url: 'https://github.com/owner/repo.git',
      });
      await expect(
        resolveSkillUrlGitInstall('https://www.github.com/owner/repo.git'),
      ).resolves.toEqual({
        url: 'https://github.com/owner/repo.git',
      });
      await expect(
        resolveSkillUrlGitInstall(
          'https://github.com/owner/repo/tree/main/skills/foo',
        ),
      ).resolves.toEqual({
        url: 'https://github.com/owner/repo.git',
        ref: 'main',
        subdirectory: 'skills/foo',
      });
      expect(isAllowedSkillUrlGitHost('github.com')).toBe(true);
      expect(isAllowedSkillUrlGitHost('evil.example')).toBe(false);
    });

    test('rejects GitHub blob URLs', async () => {
      await expect(
        resolveSkillUrlGitInstall(
          'https://github.com/owner/repo/blob/main/SKILL.md',
        ),
      ).rejects.toThrow(/blob/);
    });
  });

  describe('installSkillUrlViaPinnedGit never shells npx', () => {
    test('refuses redirect-capable public non-GitHub URL before any install IO', async () => {
      lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(
        installSkillUrlViaPinnedGit({
          packageUrl: 'https://cdn.example/skill.tgz',
          targetRoot: '/tmp/should-not-be-created-skill-url-ssrf',
        }),
      ).rejects.toThrow(/limited to GitHub/);
      expect(fs.existsSync('/tmp/should-not-be-created-skill-url-ssrf')).toBe(
        false,
      );
    });

    test('refuses GitHub URL that DNS-resolves to link-local before git clone', async () => {
      lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        installSkillUrlViaPinnedGit({
          packageUrl: 'https://github.com/owner/repo',
          targetRoot: '/tmp/should-not-be-created-skill-url-ssrf-2',
        }),
      ).rejects.toThrow(/private or link-local/);
    });
  });

  describe('both install entrypoints wired to pinned Git path', () => {
    test('src/routes/skills.ts URL branch uses installSkillUrlViaPinnedGit', () => {
      const source = fs.readFileSync(skillsRoutePath, 'utf8');
      expect(source).toContain('installSkillUrlViaPinnedGit');
      // URL branch must not call npx skills add with user pkg after only allowlist.
      const unlockedStart = source.indexOf(
        'async function installSkillForUserUnlocked',
      );
      const unlockedEnd = source.indexOf(
        'async function installSkillForUser(',
        unlockedStart,
      );
      const unlocked = source.slice(unlockedStart, unlockedEnd);
      expect(unlocked).toContain('if (isUrl)');
      expect(unlocked).toContain('installSkillUrlViaPinnedGit');
      // Inside the URL branch (before npm tempHome path), no npx skills add.
      const urlBranch = unlocked.slice(
        unlocked.indexOf('if (isUrl)'),
        unlocked.indexOf('const tempHome'),
      );
      expect(urlBranch).toContain('installSkillUrlViaPinnedGit');
      expect(urlBranch).not.toMatch(/['"]skills['"]\s*,\s*['"]add['"]/);
      expect(urlBranch).not.toContain('validateSafeHttpsUrl');
    });

    test('src/routes/workspace-config.ts URL branch uses installSkillUrlViaPinnedGit', () => {
      const source = fs.readFileSync(workspaceRoutePath, 'utf8');
      expect(source).toContain('installSkillUrlViaPinnedGit');
      const routeStart = source.indexOf(
        '/:jid/workspace-config/skills/install',
      );
      const routeEnd = source.indexOf(
        '// PATCH /workspace-config/skills/:id',
        routeStart,
      );
      const route = source.slice(routeStart, routeEnd);
      expect(route).toContain('if (isUrl)');
      expect(route).toContain('installSkillUrlViaPinnedGit');
      const urlBranch = route.slice(
        route.indexOf('if (isUrl)'),
        route.indexOf('const tempHome'),
      );
      expect(urlBranch).toContain('installSkillUrlViaPinnedGit');
      expect(urlBranch).not.toMatch(/['"]skills['"]\s*,\s*['"]add['"]/);
      expect(urlBranch).not.toContain('validateSafeHttpsUrl');
      // npm form still may use npx later in the same handler.
      expect(route).toContain("'skills'");
      expect(route).toContain("'add'");
    });
  });
});
