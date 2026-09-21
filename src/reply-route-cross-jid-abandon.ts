/**
 * Abandon a streaming card when reply-route rebuild switches to a different
 * streaming JID (cross-jid / web release of IM transport).
 *
 * Controllers' dispose() only clears timers — it does NOT patch/FINISH/abort
 * the provider card. Callers must abort first so the old card shows 「已中断」
 * instead of permanent 「生成中」.
 *
 * Mirrors held-card rotation / agent rotation / Feishu same-jid replace
 * (abort/complete before dispose). Distinct from agent silent-success catch
 * (batch-65) — this is the main reply-route cross-jid rebuild path.
 */

export type RouteChangeStreamingCard = {
  isActive(): boolean;
  abort(reason?: string): Promise<void>;
  dispose(): void;
};

/** Abort reason used when reply route leaves the previous IM streaming JID. */
export const ROUTE_CHANGE_ABORT_REASON = '连接已切换';

export type RouteChangeAbandonOutcome = 'aborted-disposed' | 'inactive';

/**
 * Terminalize-then-dispose an active card on cross-jid route rebuild.
 * Inactive sessions are left alone (caller still unregisters).
 */
export async function abandonStreamingCardOnRouteChange(
  session: RouteChangeStreamingCard,
  reason: string = ROUTE_CHANGE_ABORT_REASON,
): Promise<RouteChangeAbandonOutcome> {
  if (!session.isActive()) {
    return 'inactive';
  }
  // dispose() 只清定时器不碰卡面，会留下永久「生成中」僵尸卡；
  // abort() 内部自带 catch，会尽力把卡面切到「已中断」终态。
  await session.abort(reason).catch(() => {});
  session.dispose();
  return 'aborted-disposed';
}