// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(async () => undefined),
  logout: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({
    changePassword: mocks.changePassword,
    logout: mocks.logout,
  }),
}));
vi.mock('../../api/client', () => ({
  api: { get: vi.fn(async () => ({ sessions: [] })), delete: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SecuritySection } = await import('./SecuritySection');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  mocks.changePassword.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root.render(<SecuritySection />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)!.set!;

const field = (id: string) =>
  container.querySelector<HTMLInputElement>(`#${id}`)!;

async function type(id: string, value: string) {
  await act(async () => {
    setValue.call(field(id), value);
    field(id).dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const submitButton = () =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '修改密码',
  )!;

describe('SecuritySection change password', () => {
  test('needs the new password typed twice', async () => {
    await type('current-password', 'old-password');
    await type('new-password', 'new-password-1');
    expect(submitButton().disabled).toBe(true);

    await type('confirm-new-password', 'new-password-2');
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain('两次输入的新密码不一致');
    expect(field('confirm-new-password').getAttribute('aria-invalid')).toBe(
      'true',
    );

    await type('confirm-new-password', 'new-password-1');
    expect(container.textContent).not.toContain('两次输入的新密码不一致');
    expect(submitButton().disabled).toBe(false);

    await act(async () => submitButton().click());
    expect(mocks.changePassword).toHaveBeenCalledWith(
      'old-password',
      'new-password-1',
    );
    expect(field('confirm-new-password').value).toBe('');
  });

  test('does not flag a mismatch while the confirmation is still short', async () => {
    await type('new-password', 'new-password-1');
    await type('confirm-new-password', 'new-pa');
    expect(container.textContent).not.toContain('两次输入的新密码不一致');
  });

  test('every password field can be revealed', async () => {
    for (const id of [
      'current-password',
      'new-password',
      'confirm-new-password',
    ]) {
      const toggle = container.querySelector<HTMLButtonElement>(
        `button[aria-controls="${id}"]`,
      )!;
      expect(field(id).type).toBe('password');
      expect(toggle.getAttribute('aria-label')).toBe('显示密码');
      await act(async () => toggle.click());
      expect(field(id).type).toBe('text');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.getAttribute('aria-label')).toBe('隐藏密码');
    }
  });
});
