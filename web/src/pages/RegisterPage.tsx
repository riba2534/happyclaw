import { Navigate } from 'react-router-dom';
import { useIsSingleUserHost } from '../lib/deployment-mode';

export function RegisterPage() {
  // Single-user host mode has no registration (the server refuses it too).
  const singleUserHost = useIsSingleUserHost();
  return (
    <Navigate
      to={singleUserHost ? '/settings' : '/login?tab=register'}
      replace
    />
  );
}
