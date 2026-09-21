/**
 * Silent-success streaming-card finalize helper.
 *
 * Used by the agent warm-session cleanup path when complete() was skipped on
 * the result path (send_message side-channel / empty result) and we still need
 * to terminalize a visible streaming card.
 *
 * Mirror of the main-path twin in index.ts: on complete() failure, abort('')
 * then dispose(). Bare dispose() only clears timers and leaves permanent
 * 「生成中」 zombie cards while the turn can still settle SUCCESS.
 */

export type SilentSuccessStreamingCard = {
  complete(text: string): Promise<void>;
  abort(reason?: string): Promise<void>;
  dispose(): void;
};

export type SilentSuccessFinalizeOutcome = 'completed' | 'aborted-disposed';

/**
 * Attempt complete(); on failure abort('') (best-effort terminalize) then
 * dispose() (clear timers). Never bare-dispose on complete failure.
 */
export async function finalizeSilentSuccessCard(
  session: SilentSuccessStreamingCard,
  text: string,
  onCompleteFailure: (err: unknown) => void,
): Promise<SilentSuccessFinalizeOutcome> {
  try {
    await session.complete(text);
    return 'completed';
  } catch (err) {
    onCompleteFailure(err);
    // dispose() 只清定时器不碰卡面，会留下永久「生成中」僵尸卡；
    // abort() 内部自带 catch，会尽力把卡面切到「已中断」终态。
    await session.abort('').catch(() => {});
    session.dispose();
    return 'aborted-disposed';
  }
}
