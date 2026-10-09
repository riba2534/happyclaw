/** App-relative route for the current URL, handling hash routing and base. */
function appRoute(pathname: string, hash: string, appBase: string): string {
  const hashRoute = hash.startsWith('#/') ? hash.slice(1) : '';
  let route = hashRoute || pathname || '/';
  route = route.split(/[?#]/, 1)[0] || '/';

  if (!hashRoute && appBase !== '/') {
    const base = appBase.endsWith('/') ? appBase.slice(0, -1) : appBase;
    if (route === base) {
      route = '/';
    } else if (route.startsWith(`${base}/`)) {
      route = route.slice(base.length) || '/';
    }
  }
  return route;
}

export function shouldPreloadChatRoute(
  pathname: string,
  hash: string,
  appBase: string,
): boolean {
  const route = appRoute(pathname, hash, appBase);
  return route === '/' || route === '/chat' || route.startsWith('/chat/');
}

/**
 * Every signed-in route renders inside AppLayout; fetching its chunk at entry
 * (instead of after the auth guard resolves) removes a serial hop before the
 * first data request. Public pages skip it.
 */
export function shouldPreloadAppShell(
  pathname: string,
  hash: string,
  appBase: string,
): boolean {
  const route = appRoute(pathname, hash, appBase);
  return !/^\/(?:login|register|setup)(?:\/|$)/.test(route);
}
