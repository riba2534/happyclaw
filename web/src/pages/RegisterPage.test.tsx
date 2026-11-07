// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { deploymentMode: undefined as string | undefined },
}));
vi.mock('../stores/auth', () => ({
  useAuthStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));

const { RegisterPage } = await import('./RegisterPage');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Where() {
  const location = useLocation();
  return <>{location.pathname + location.search}</>;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.state.deploymentMode = undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function openRegister() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/register']}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container.textContent;
}

describe('/register', () => {
  test('opens the register tab with multi_user or an older server', async () => {
    expect(await openRegister()).toBe('/login?tab=register');
  });

  test('redirects to settings in single-user host mode', async () => {
    mocks.state.deploymentMode = 'single_user_host';
    expect(await openRegister()).toBe('/settings');
  });
});
