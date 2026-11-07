// Deployment mode and workspace root: Settings inside the real AppLayout on
// a signed-in admin, and the first-run /setup page. `?route=` picks the
// first page, `?mode=single_user_host` the deployment mode the server
// reported, `?setup=1` an uninitialized instance; the spec answers every
// /api request with page.route.
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AppLayout } from '../../src/components/layout/AppLayout';
import { AuthGuard } from '../../src/components/auth/AuthGuard';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from '../../src/components/ui/sonner';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { SetupPage } from '../../src/pages/SetupPage';
import { wsManager } from '../../src/api/ws';
import {
  parseDeploymentMode,
  useAuthStore,
  type UserPublic,
} from '../../src/stores/auth';
import { useBillingStore } from '../../src/stores/billing';
import { useChatStore } from '../../src/stores/chat';
import { useGroupsStore } from '../../src/stores/groups';
import '../../src/styles/globals.css';

const BASENAME = '/tests/e2e/single-user-host-harness.html';
const params = new URLSearchParams(window.location.search);
const initialRoute = params.get('route') || '/settings';
const setup = params.get('setup') === '1';

wsManager.connect = () => undefined;

const user: UserPublic = {
  id: 'admin-user',
  username: 'admin',
  display_name: '管理员',
  role: 'admin',
  status: 'active',
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  ai_name: null,
  ai_avatar_emoji: null,
  ai_avatar_color: null,
  ai_avatar_url: null,
  default_require_mention: false,
};

useAuthStore.setState(
  setup
    ? { authenticated: false, user: null, initialized: false, checking: false }
    : {
        authenticated: true,
        user,
        initialized: true,
        checking: false,
        deploymentMode: parseDeploymentMode(params.get('mode')),
      },
);
useBillingStore.setState({
  billingEnabled: false,
  loadBillingStatus: async () => undefined,
} as never);
useGroupsStore.setState({
  runnerStates: {},
  loadGroups: async () => undefined,
} as never);
useChatStore.setState({ loadGroups: async () => undefined } as never);

function RouteProbe() {
  const location = useLocation();
  return (
    <output data-testid="route" hidden>
      {location.pathname + location.search}
    </output>
  );
}

const guarded = (page: string) => (
  <AuthGuard>
    <h1>{page}</h1>
  </AuthGuard>
);

createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename={BASENAME}>
    <Routes>
      <Route index element={<Navigate to={initialRoute} replace />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/setup/providers" element={<h1>接入配置</h1>} />
      <Route element={<AppLayout />}>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/users" element={guarded('用户管理页')} />
        <Route path="/billing" element={guarded('账单页')} />
        <Route path="*" element={<h1>页面</h1>} />
      </Route>
    </Routes>
    <RouteProbe />
    <ConfirmHost />
    <Toaster />
  </BrowserRouter>,
);
