// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    initialized: false as boolean | null,
    authenticated: false,
    deploymentMode: 'multi_user' as 'multi_user' | 'single_user_host',
    deploymentModeSource: 'default' as 'settings' | 'env' | 'default' | null,
    checkStatus: vi.fn(),
    setupAdmin: vi.fn(async () => undefined),
  },
}));
vi.mock('../stores/auth', () => ({
  useAuthStore: () => mocks.state,
}));

const { SetupPage } = await import('./SetupPage');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.state.setupAdmin.mockClear();
  mocks.state.deploymentMode = 'multi_user';
  mocks.state.deploymentModeSource = 'default';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)!.set!;

async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const modeRadio = (value: string) =>
  container.querySelector<HTMLInputElement>(
    `input[name="deployment_mode"][value="${value}"]`,
  )!;

async function renderAndSubmit(pick?: string) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>,
    );
  });
  if (pick) await act(async () => modeRadio(pick).click());
  await type('#setup-username', 'admin');
  await type('#setup-password', 'password-123');
  await type('#setup-confirm', 'password-123');
  await act(async () =>
    container.querySelector<HTMLFormElement>('form')!.requestSubmit(),
  );
}

describe('setup: 你打算怎么用？', () => {
  test('asks first and recommends single-user host', async () => {
    await renderAndSubmit();
    expect(container.textContent).toContain('你打算怎么用？');
    expect(modeRadio('single_user_host').checked).toBe(true);
    expect(
      modeRadio('single_user_host').closest('label')?.textContent,
    ).toContain('单人宿主机（推荐）');
    expect(mocks.state.setupAdmin).toHaveBeenCalledWith(
      'admin',
      'password-123',
      'single_user_host',
    );
  });

  test('sends multi_user when chosen', async () => {
    await renderAndSubmit('multi_user');
    expect(mocks.state.setupAdmin).toHaveBeenCalledWith(
      'admin',
      'password-123',
      'multi_user',
    );
  });

  test('keeps a mode from the environment and does not send it', async () => {
    mocks.state.deploymentModeSource = 'env';
    await renderAndSubmit();
    expect(modeRadio('multi_user').checked).toBe(true);
    expect(
      container.querySelector('[data-testid="setup-deployment-mode-source"]')
        ?.textContent,
    ).toContain('HAPPYCLAW_DEPLOYMENT_MODE');
    expect(mocks.state.setupAdmin).toHaveBeenCalledWith(
      'admin',
      'password-123',
      undefined,
    );
  });

  test('sends the mode when the environment one is changed', async () => {
    mocks.state.deploymentModeSource = 'env';
    await renderAndSubmit('single_user_host');
    expect(mocks.state.setupAdmin).toHaveBeenCalledWith(
      'admin',
      'password-123',
      'single_user_host',
    );
  });

  test('shows no source note when the mode is only the default', async () => {
    await renderAndSubmit();
    expect(
      container.querySelector('[data-testid="setup-deployment-mode-source"]'),
    ).toBeNull();
  });
});
