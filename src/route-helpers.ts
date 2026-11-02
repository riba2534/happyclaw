// Small helpers for route modules that sit on a service with its own error
// type (automations, team mode): the error boundary, path and query
// parameters, and the JSON body.

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';

import { logger } from './logger.js';
import type { Variables } from './web-context.js';

export type RouteContext = Context<{ Variables: Variables }>;

/** A refusal the service throws on purpose; its message is safe to show. */
export interface RouteRefusal {
  message: string;
  status: ContentfulStatusCode;
  /** Machine-readable reason, answered as `code` when present. */
  code?: string;
}

/**
 * Wrap handlers: `resolve` supplies what each handler needs or answers on its
 * own (a missing service, a refused caller), a refusal becomes `{ error,
 * code? }` with its status, anything else is logged and answers 500.
 */
export function errorBoundary<T>(options: {
  resolve: (c: RouteContext) => T | Response;
  isRefusal: (error: unknown) => error is RouteRefusal;
  failureLog: string;
}) {
  return (
      handler: (c: RouteContext, resolved: T) => Promise<Response> | Response,
    ) =>
    async (c: RouteContext) => {
      const resolved = options.resolve(c);
      if (resolved instanceof Response) return resolved;
      try {
        return await handler(c, resolved);
      } catch (error) {
        if (options.isRefusal(error)) {
          return c.json(
            {
              error: error.message,
              ...(error.code ? { code: error.code } : {}),
            },
            error.status,
          );
        }
        logger.error({ err: error, path: c.req.path }, options.failureLog);
        return c.json({ error: '操作失败，请稍后重试' }, 500);
      }
    };
}

export function param(c: RouteContext, name: string): string {
  return c.req.param(name) ?? '';
}

/** `?limit=`: a number, or undefined for the service default. */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  // A row count: whole numbers only, so SQL LIMIT never sees a fraction.
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** The JSON body parsed with `schema`; throws `invalid()` when it does not fit. */
export async function readBody<T>(
  c: RouteContext,
  schema: ZodType<T>,
  invalid: () => Error,
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw invalid();
  return parsed.data;
}
