import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('WeCom full-stack provider registration', () => {
  test('uses channel-account session mounts for DMs instead of Feishu auto_im isolation', () => {
    const isolation = read('src/im-context-isolation.ts');
    expect(isolation).toContain("if (channelType === 'feishu')");
    expect(isolation).not.toContain('wecom');

    const runtime = read('src/index.ts');
    expect(runtime).toContain('attachDefaultChannelAccountMount(');
    expect(runtime).not.toContain('applyChannelAccountRegistrationFallback(');
  });

  test('registers account-scoped admission and transport status in runtime', () => {
    const source = read('src/index.ts');
    const start = source.indexOf("} else if (account.provider === 'wecom') {");
    const end = source.indexOf(
      "} else if (account.provider === 'dingtalk') {",
      start,
    );
    const branch = source.slice(start, end);
    expect(branch).toContain('isChatAuthorized: buildIsChatAuthorized(');
    expect(branch).toContain('onPairAttempt: buildOnPairAttempt(');
    expect(branch).toContain('workspace.jid');
    expect(branch).toContain('onConnectionStateChange: (state) =>');
    expect(branch).toContain("state.status === 'connected'");
    expect(branch).toContain('resolveRegisteredGroup: getRegisteredGroup');
  });

  test('does not route unknown providers through the WhatsApp legacy branch', () => {
    const source = read('src/routes/channel-accounts.ts');
    expect(source).toContain(
      "} else if (account.provider === 'whatsapp') {\n    saveUserWhatsAppConfig",
    );
    expect(source).toContain("if (provider === 'whatsapp') {");
    expect(source).toContain('return null;');

    const runtime = read('src/index.ts');
    expect(runtime).toContain(
      "} else if (account.provider === 'whatsapp') {\n      if (account.is_legacy_default)",
    );
    expect(runtime).toContain('Unsupported channel provider');
  });

  test('registers backend and frontend capability and notification surfaces', () => {
    for (const file of [
      'src/im-channel-capabilities.ts',
      'web/src/constants/im-capabilities.ts',
      'web/src/components/settings/channel-meta.tsx',
      'web/src/utils/channel-accounts.ts',
      'web/src/stores/channel-accounts.ts',
      'web/src/utils/task-utils.ts',
      'src/task-scheduler.ts',
      'src/schemas.ts',
    ]) {
      expect(read(file), file).toContain('wecom');
    }
  });

  test('passes the exact durable input message id into streaming sessions', () => {
    const source = read('src/index.ts');
    expect(source).toContain('inputMessageId: inputCursor?.id ?? inputTurnId');
    expect(source).toContain('admitted.inputMessageId');
    expect(source).toContain('lastProcessed.id');
  });
});
