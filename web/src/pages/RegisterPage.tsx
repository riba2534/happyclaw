import { Navigate } from 'react-router-dom';

export function RegisterPage() {
  return <Navigate to="/login?tab=register" replace />;
}
