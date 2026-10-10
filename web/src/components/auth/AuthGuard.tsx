import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { type Permission, useAuthStore } from '../../stores/auth';
import { LogoLoading } from '../common/LogoLoading';

interface AuthGuardProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
  requiredPermission?: Permission;
  requiredAnyPermissions?: Permission[];
}

export function AuthGuard({
  children,
  requireAdmin,
  requiredPermission,
  requiredAnyPermissions,
}: AuthGuardProps) {
  const {
    authenticated,
    checking,
    checkAuth,
    user,
    initialized,
    setupStatus,
    hasPermission,
  } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const checkedRef = useRef(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    // Nested guards (e.g. /monitor inside the layout guard) only check
    // permissions. Re-running checkAuth would flip `checking` and make the
    // outer guard unmount and remount the whole app shell.
    const { authenticated: signedIn, checking: pending } =
      useAuthStore.getState();
    if (signedIn && !pending) return;
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!checking) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), 12000);
    return () => window.clearTimeout(timer);
  }, [checking]);

  if (checking) {
    if (timedOut) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div
            role="alert"
            className="w-full max-w-md rounded-xl bg-surface-raised p-6 text-center shadow-floating ring-1 ring-surface-border"
          >
            <h2 className="text-title text-foreground">页面初始化超时</h2>
            <p className="mt-2 text-body text-muted-foreground">
              后端可能刚启动或浏览器缓存异常，请先刷新页面；若仍失败，重新登录。
            </p>
            <div className="mt-5 flex items-center justify-center gap-2">
              <Button onClick={() => window.location.reload()}>刷新页面</Button>
              <Button
                variant="outline"
                onClick={() => {
                  navigate('/login', { replace: true });
                }}
              >
                去登录页
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return <LogoLoading full />;
  }

  // System not initialized — redirect to setup page
  if (initialized === false) {
    return <Navigate to="/setup" replace />;
  }

  if (!authenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Users with must_change_password go to settings
  if (user?.must_change_password && location.pathname !== '/settings') {
    return <Navigate to="/settings" replace />;
  }

  // Admin onboarding: force provider setup flow before entering full app.
  if (
    user?.role === 'admin' &&
    setupStatus?.needsSetup &&
    location.pathname !== '/setup/providers'
  ) {
    return <Navigate to="/setup/providers" replace />;
  }

  if (requireAdmin && user?.role !== 'admin') {
    return <Navigate to="/chat" replace />;
  }

  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <Navigate to="/chat" replace />;
  }

  if (requiredAnyPermissions && requiredAnyPermissions.length > 0) {
    const matched = requiredAnyPermissions.some((perm) => hasPermission(perm));
    if (!matched) return <Navigate to="/chat" replace />;
  }

  return <>{children}</>;
}
