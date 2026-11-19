// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock('../../api/client', () => ({ api }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { TwoFactorSection } = await import('./TwoFactorSection');
const { emulatePointer } = await import('../ui/overlay-test-utils');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const button = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TwoFactorSection', () => {
  test('enrolment shows the QR code, then the recovery codes once', async () => {
    api.get.mockResolvedValue({ enabled: false, recovery_codes_remaining: 0 });
    api.post.mockImplementation(async (path: string) =>
      path === '/api/auth/2fa/setup'
        ? {
            secret: 'JBSWY3DPEHPK3PXP',
            otpauth_uri: 'otpauth://totp/x',
            qr_data_url: 'data:image/png;base64,AAAA',
          }
        : { recovery_codes: ['abcde-fghij', 'klmno-pqrst'] },
    );
    await act(async () => root.render(<TwoFactorSection />));
    expect(container.textContent).toContain('未开启');

    await act(async () => button('开启').click());
    expect(
      document.querySelector<HTMLImageElement>('img[alt="二次验证二维码"]')
        ?.src,
    ).toContain('data:image/png');
    expect(document.body.textContent).toContain('JBSWY3DPEHPK3PXP');

    // A link a phone's authenticator opens, and the key to copy.
    expect(
      document
        .querySelector<HTMLAnchorElement>('a[href^="otpauth:"]')
        ?.getAttribute('href'),
    ).toBe('otpauth://totp/x');
    expect(button('复制')).toBeDefined();

    const code = document.querySelector<HTMLInputElement>('#two-factor-code')!;
    expect(code.autocomplete).toBe('one-time-code');
    await type(code, '123456');
    // Turning it on takes the current password too.
    expect(button('确认').disabled).toBe(true);
    await type(
      document.querySelector<HTMLInputElement>('#two-factor-password')!,
      'secret-password',
    );
    await act(async () => button('确认').click());
    expect(api.post).toHaveBeenCalledWith('/api/auth/2fa/enable', {
      password: 'secret-password',
      code: '123456',
    });
    expect(document.body.textContent).toContain('abcde-fghij');
    expect(button('我已保存')).toBeDefined();
  });

  test('on a phone, opening setup does not raise the keyboard over the QR code', async () => {
    emulatePointer('phone');
    api.get.mockResolvedValue({ enabled: false, recovery_codes_remaining: 0 });
    api.post.mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauth_uri: 'otpauth://totp/x',
      qr_data_url: 'data:image/png;base64,AAAA',
    });
    await act(async () => root.render(<TwoFactorSection />));
    await act(async () => button('开启').click());
    expect(document.querySelector('img[alt="二次验证二维码"]')).not.toBeNull();
    expect(document.activeElement?.tagName).not.toBe('INPUT');
  });

  test('a wrong password is reported by its code', async () => {
    api.get.mockResolvedValue({ enabled: true, recovery_codes_remaining: 7 });
    api.post.mockRejectedValue({
      status: 400,
      message: 'something in English',
      body: { code: 'CURRENT_PASSWORD_INCORRECT' },
    });
    await act(async () => root.render(<TwoFactorSection />));
    await act(async () => button('关闭').click());
    await type(
      document.querySelector<HTMLInputElement>('#two-factor-password')!,
      'nope',
    );
    await type(
      document.querySelector<HTMLInputElement>('#two-factor-code')!,
      '123456',
    );
    const submit = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === '关闭',
    );
    await act(async () => submit[submit.length - 1].click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      '当前密码不正确',
    );
  });

  test('turning off asks for the password and a code', async () => {
    api.get.mockResolvedValue({ enabled: true, recovery_codes_remaining: 7 });
    api.post.mockResolvedValue({ success: true });
    await act(async () => root.render(<TwoFactorSection />));
    expect(container.textContent).toContain('剩余 7 个恢复码');

    await act(async () => button('关闭').click());
    const password = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    // The first field takes focus, not the code below it.
    expect(document.activeElement).toBe(password);
    await type(password, 'secret-password');
    await type(
      document.querySelector<HTMLInputElement>('#two-factor-code')!,
      'abcde-fghij',
    );
    const submit = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === '关闭',
    );
    await act(async () => submit[submit.length - 1].click());
    expect(api.post).toHaveBeenCalledWith('/api/auth/2fa/disable', {
      password: 'secret-password',
      code: 'abcde-fghij',
    });
  });
});
