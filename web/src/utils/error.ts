import type { ApiError } from '../api/client';

/** Extract a human-readable message from an unknown catch value. */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err)
    return (err as ApiError).message;
  return String(err);
}
