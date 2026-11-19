// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PairingSection } from './PairingSection';
import { ProviderConnectionFields } from './channel-accounts/ProviderConnectionFields';
import { PAIRING_OWNER_RISK_NOTE } from '../../utils/channel-accounts';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container;
}

function unmount() {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

afterEach(unmount);

async function guideText(provider: 'telegram' | 'whatsapp' | 'feishu') {
  const view = await mount(
    <ProviderConnectionFields
      provider={provider}
      values={{}}
      onChange={vi.fn()}
      idPrefix={provider}
    />,
  );
  const text = view.textContent ?? '';
  unmount();
  return text;
}

const pairing = {
  code: null,
  countdown: 0,
  generating: false,
  copied: false,
  generate: vi.fn(),
  copyCommand: vi.fn(),
};

const paired = {
  chats: [],
  loading: false,
  removingJid: null,
  load: vi.fn(),
  remove: vi.fn(),
};

describe('what pairing a chat grants', () => {
  test('the pairing section says a paired direct chat is you', async () => {
    const view = await mount(
      <PairingSection
        channelName="Telegram"
        pairing={pairing}
        paired={paired}
      />,
    );
    const note = Array.from(view.querySelectorAll('p')).find((p) =>
      p.textContent?.includes(PAIRING_OWNER_RISK_NOTE),
    );
    expect(note).toBeDefined();
    expect(note!.className).toContain('text-warning');
    expect(PAIRING_OWNER_RISK_NOTE).toContain('宿主机工作区');
    expect(PAIRING_OWNER_RISK_NOTE).toContain('只给你自己的账号配对');
  });

  test('the setup guide says it for providers that pair chats, and only those', async () => {
    // Credentials and QR providers render the guide on separate paths.
    expect(await guideText('telegram')).toContain(PAIRING_OWNER_RISK_NOTE);
    expect(await guideText('whatsapp')).toContain(PAIRING_OWNER_RISK_NOTE);
    // Feishu has no pairing: its owner comes from the bot configuration.
    expect(await guideText('feishu')).not.toContain(PAIRING_OWNER_RISK_NOTE);
  });
});
