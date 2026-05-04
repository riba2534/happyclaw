import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isRouteRestoreEnabled, saveLastRoute, getLastRoute } from '../utils/routeRestore';

// Paths that count as "fresh app launch" — a PWA cold start lands on the
// manifest start_url (`/chat`). When the user opens a deep link directly we
// honor it instead of overriding with the saved route.
const RESTORE_TRIGGER_PATHS = new Set(['/chat', '/']);

export function useRouteRestore(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    if (!isRouteRestoreEnabled()) return;
    if (!RESTORE_TRIGGER_PATHS.has(location.pathname)) return;

    const saved = getLastRoute();
    if (!saved) return;

    const currentFull = location.pathname + location.search;
    if (saved === currentFull) return;

    navigate(saved, { replace: true });
    // Run only on initial mount; subsequent location changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isRouteRestoreEnabled()) return;
    saveLastRoute(location.pathname + location.search);
  }, [location.pathname, location.search]);
}
