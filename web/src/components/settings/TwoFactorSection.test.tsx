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

    const code = document.querySelector<HTMLInputElement>('#two-factor-code')!;
    expect(code.autocomplete).toBe('one-time-code');
    expect(button('确认').disabled).toBe(true);
    await type(code, '123456');
    await act(async () => button('确认').click());
    expect(api.post).toHaveBeenCalledWith('/api/auth/2fa/enable', {
      code: '123456',
    });
    expect(document.body.textContent).toContain('abcde-fghij');
    expect(button('我已保存')).toBeDefined();
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
