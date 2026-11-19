// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));
const browser = vi.hoisted(() => ({ startRegistration: vi.fn() }));
vi.mock('../../api/client', () => ({ api }));
vi.mock('@simplewebauthn/browser', () => browser);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { PasskeySection } = await import('./PasskeySection');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  browser.startRegistration.mockReset();
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
  });
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential =
    function PublicKeyCredential() {};
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const button = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

const PASSKEY = {
  id: 'cred-1',
  name: 'Mac',
  rp_id: 'claw.example.com',
  created_at: '2026-11-01T00:00:00.000Z',
  last_used_at: null,
};

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PasskeySection', () => {
  test('adding asks for the password, then runs the browser ceremony', async () => {
    api.get.mockResolvedValue({
      passkeys: [],
      rp_id: 'claw.example.com',
      unavailable_reason: null,
      two_factor_enabled: false,
    });
    api.post.mockImplementation(async (path: string) =>
      path === '/api/auth/passkeys/options'
        ? { challenge: 'abc' }
        : { success: true, passkey: PASSKEY },
    );
    browser.startRegistration.mockResolvedValue({ id: 'cred-1' });
    await act(async () => root.render(<PasskeySection />));
    await act(async () => button('添加通行密钥').click());
    expect(api.post).not.toHaveBeenCalled();
    expect(document.querySelector('#passkey-code')).toBeNull();
    await type(
      document.querySelector<HTMLInputElement>('#passkey-password')!,
      'secret-password',
    );
    await act(async () => button('继续').click());
    expect(api.post).toHaveBeenCalledWith('/api/auth/passkeys/options', {
      password: 'secret-password',
    });
    expect(browser.startRegistration).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'abc' },
    });
    expect(api.post).toHaveBeenCalledWith('/api/auth/passkeys', {
      response: { id: 'cred-1' },
      name: expect.any(String),
    });
  });

  test('with two-factor on, adding also asks for a code', async () => {
    api.get.mockResolvedValue({
      passkeys: [],
      rp_id: 'claw.example.com',
      unavailable_reason: null,
      two_factor_enabled: true,
    });
    api.post.mockRejectedValue({
      status: 400,
      message: 'Invalid verification code',
      body: { code: 'MFA_INVALID' },
    });
    await act(async () => root.render(<PasskeySection />));
    await act(async () => button('添加通行密钥').click());
    await type(
      document.querySelector<HTMLInputElement>('#passkey-password')!,
      'secret-password',
    );
    expect(button('继续').disabled).toBe(true);
    await type(
      document.querySelector<HTMLInputElement>('#passkey-code')!,
      '123456',
    );
    await act(async () => button('继续').click());
    expect(api.post).toHaveBeenCalledWith('/api/auth/passkeys/options', {
      password: 'secret-password',
      code: '123456',
    });
    expect(browser.startRegistration).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      '验证码不正确',
    );
  });

  test('an HTTP address explains why passkeys are unavailable', async () => {
    api.get.mockResolvedValue({
      passkeys: [PASSKEY],
      rp_id: null,
      unavailable_reason: 'insecure',
    });
    await act(async () => root.render(<PasskeySection />));
    expect(container.textContent).toContain('HTTPS');
    expect(container.textContent).toContain('Mac');
    expect(button('添加通行密钥').disabled).toBe(true);
  });

  test('an IP address asks for localhost or a domain', async () => {
    api.get.mockResolvedValue({
      passkeys: [],
      rp_id: null,
      unavailable_reason: 'ip_host',
    });
    await act(async () => root.render(<PasskeySection />));
    expect(container.textContent).toContain('请用 localhost');
    expect(button('添加通行密钥').disabled).toBe(true);
  });
});
