import { Navigate } from 'react-router-dom';

/**
 * Registration is now handled inline on the LoginPage.
 * This route redirects for backwards compatibility.
 */
export function RegisterPage() {
  return <Navigate to="/login?tab=register" replace />;
}
