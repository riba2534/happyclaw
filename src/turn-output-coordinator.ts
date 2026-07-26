import crypto from 'node:crypto';

/**
 * User-visible delivery semantics are deliberately owned by the HappyClaw
 * host, not inferred from the fact that an MCP tool happened to run.
 */
export type TurnMessageDeliveryRole = 'progress' | 'final' | 'separate';

export interface TurnOutputStreamEvent {
  eventType: string;
  text?: string;
  parentToolUseId?: string | null;
  toolName?: string;
  messageUuid?: string;
  rawType?: string;
}

export interface TurnOutputProjection {
  answerText: string;
  answerChanged: boolean;
  visibleAnswerText: string;
  visibleAnswerChanged: boolean;
  narrationDiscarded: boolean;
  provisionalText: string;
}

export interface ResolvedPrimaryAnswer {
  text: string | null;
  source: 'sdk_final' | 'mcp_final' | 'candidate' | 'empty';
}

interface PreparedTurnMessage {
  role: Exclude<TurnMessageDeliveryRole, 'separate'>;
  text: string;
  fingerprint: string;
  duplicate: boolean;
}

/**
 * Pure reducer for one user input turn.
 *
 * Raw SDK text deltas are provisional until the model either calls a tool or
 * reaches its final result. If a top-level tool starts after text was emitted,
 * that text is process narration and is removed from the answer lane. This
 * mirrors Claude Code's assistant-message semantics while still allowing the
 * live card to show a provisional candidate and roll it back deterministically.
 */
export class TurnOutputCoordinator {
  private answerCandidate = '';
  private readonly narrationSegments: string[] = [];
  private activeMessage:
    | {
        id: string;
        text: string;
        hasTopLevelTool: boolean;
      }
    | undefined;
  private implicitMessageCounter = 0;
  private stagedFinal: string | null = null;
  private finalized = false;
  private deliveredUtteranceCount = 0;
  private readonly stagedFingerprints = new Set<string>();

  /**
   * Safety fuse for a runaway model loop, not a UX limit. `0` disables it.
   *
   * Proactive mode hands the "how many messages" decision to the model, so the
   * framework needs its own bound on user-visible output; every delivered
   * message is an irreversible side effect in a real chat. The number is
   * deliberately kept out of the prompt so the model cannot treat it as a quota
   * to spend — it only ever learns about it as a `reply_limit_reached` refusal.
   */
  constructor(private readonly maxUtterances = 0) {}

  /** Checked before delivery; recordDeliveredUtterance runs after it succeeds. */
  canDeliverUtterance(): boolean {
    if (this.finalized) return false;
    if (this.maxUtterances <= 0) return true;
    return this.deliveredUtteranceCount < this.maxUtterances;
  }

  reduceStreamEvent(event: TurnOutputStreamEvent): TurnOutputProjection {
    const before = this.answerCandidate;
    const beforeVisible = this.visibleAnswerText;
    let narrationDiscarded = false;
    const isMessageStart =
      event.eventType === 'raw_sdk_event' &&
      event.rawType === 'stream_event/message_start' &&
      !event.parentToolUseId;
    const isMessageStop =
      event.eventType === 'raw_sdk_event' &&
      event.rawType === 'stream_event/message_stop' &&
      !event.parentToolUseId;

    if (isMessageStart) {
      this.activeMessage = {
        id: event.messageUuid || `implicit-${++this.implicitMessageCounter}`,
        text: '',
        hasTopLevelTool: false,
      };
    }

    if (
      event.eventType === 'text_delta' &&
      event.text &&
      !event.parentToolUseId
    ) {
      const message = this.ensureActiveMessage(event.messageUuid);
      message.text += event.text;
    } else if (event.eventType === 'tool_use_start' && !event.parentToolUseId) {
      const message = this.ensureActiveMessage(event.messageUuid);
      message.hasTopLevelTool = true;
    }

    if (isMessageStop && this.activeMessage) {
      if (this.activeMessage.hasTopLevelTool) {
        if (this.activeMessage.text.trim()) {
          this.narrationSegments.push(this.activeMessage.text);
        }
        this.answerCandidate = '';
        narrationDiscarded = true;
      } else {
        this.answerCandidate = this.activeMessage.text;
      }
      this.activeMessage = undefined;
    }

    return {
      answerText: this.answerCandidate,
      answerChanged: before !== this.answerCandidate,
      visibleAnswerText: this.visibleAnswerText,
      visibleAnswerChanged: beforeVisible !== this.visibleAnswerText,
      narrationDiscarded,
      provisionalText: this.activeMessage?.text ?? '',
    };
  }

  private ensureActiveMessage(
    messageUuid?: string,
  ): NonNullable<TurnOutputCoordinator['activeMessage']> {
    if (!this.activeMessage) {
      this.activeMessage = {
        id: messageUuid || `implicit-${++this.implicitMessageCounter}`,
        text: '',
        hasTopLevelTool: false,
      };
    }
    return this.activeMessage;
  }

  get candidateText(): string {
    return this.answerCandidate;
  }

  /**
   * The live card may render a tool-free message provisionally. Once the same
   * AssistantMessage reveals a top-level tool call, this immediately rolls
   * back to the last committed candidate; canonical persistence still waits
   * for message_stop.
   */
  get visibleAnswerText(): string {
    if (this.activeMessage && !this.activeMessage.hasTopLevelTool) {
      return this.activeMessage.text;
    }
    return this.answerCandidate;
  }

  get lastNarration(): string | null {
    return this.narrationSegments.at(-1) ?? null;
  }

  /**
   * Stage a non-separate MCP message into this turn. Returns false after the
   * primary answer has finalized, so a late/replayed IPC file cannot create a
   * sibling answer.
   */
  stageMessage(
    role: Exclude<TurnMessageDeliveryRole, 'separate'>,
    text: string,
  ): { accepted: boolean; duplicate: boolean } {
    const prepared = this.prepareMessage(role, text);
    if (!prepared) {
      return { accepted: false, duplicate: false };
    }
    if (!prepared.duplicate) this.commitPreparedMessage(prepared);
    return { accepted: true, duplicate: prepared.duplicate };
  }

  prepareMessage(
    role: Exclude<TurnMessageDeliveryRole, 'separate'>,
    text: string,
  ): PreparedTurnMessage | null {
    if (this.finalized || !text.trim()) return null;
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${role}\0${text}`)
      .digest('hex');
    return {
      role,
      text,
      fingerprint,
      duplicate: this.stagedFingerprints.has(fingerprint),
    };
  }

  commitPreparedMessage(prepared: PreparedTurnMessage): void {
    if (prepared.duplicate) return;
    this.stagedFingerprints.add(prepared.fingerprint);
    if (prepared.role === 'final') {
      this.stagedFinal = prepared.text;
      this.answerCandidate = prepared.text;
    }
  }

  /** SDK Result is authoritative when it contains a real final answer. */
  resolvePrimaryAnswer(
    sdkResult: string | null | undefined,
  ): ResolvedPrimaryAnswer {
    const sdkText = sdkResult?.trim() ? sdkResult : null;
    // Result.success.result is the SDK's authoritative answer. Never reject
    // it based on a heuristic comparison with earlier process narration.
    if (sdkText) {
      return { text: sdkText, source: 'sdk_final' };
    }
    if (this.stagedFinal?.trim()) {
      return { text: this.stagedFinal, source: 'mcp_final' };
    }
    if (this.answerCandidate.trim()) {
      return { text: this.answerCandidate, source: 'candidate' };
    }
    return { text: null, source: 'empty' };
  }

  markFinalized(): void {
    this.finalized = true;
  }

  recordDeliveredUtterance(): boolean {
    if (this.finalized) return false;
    this.deliveredUtteranceCount += 1;
    return true;
  }

  get deliveredUtterances(): number {
    return this.deliveredUtteranceCount;
  }

  get hasDeliveredUtterance(): boolean {
    return this.deliveredUtteranceCount > 0;
  }
}

export interface ActiveTurnOutputCallbacks {
  onProgress: (text: string) => boolean;
  onFinalCandidate: (text: string) => boolean;
  onUtteranceDelivered?: () => void;
}

interface ActiveTurnOutputBinding {
  coordinator: TurnOutputCoordinator;
  callbacks: ActiveTurnOutputCallbacks;
}

export interface StageTurnMessageInput {
  scopeKey: string;
  inputTurnId: string;
  role: Exclude<TurnMessageDeliveryRole, 'separate'>;
  text: string;
}

export interface StageTurnMessageResult {
  accepted: boolean;
  duplicate: boolean;
  reason?: 'inactive_turn' | 'finalized' | 'projection_unavailable';
}

export interface RecordDeliveredUtteranceInput {
  scopeKey: string;
  inputTurnId: string;
}

/**
 * Process-local bridge between the IPC watcher and the foreground Agent turn.
 * The durable Turn/Outbox remains the authority for physical side effects;
 * this registry only ensures progress/final text joins the existing primary
 * projection instead of becoming a second provider message.
 */
export class ActiveTurnOutputRegistry {
  private readonly bindings = new Map<string, ActiveTurnOutputBinding>();

  /**
   * Read lazily per turn so a settings change applies to newly started turns
   * without a restart, while a turn already in flight keeps the bound it began
   * with.
   */
  constructor(private readonly maxUtterancesProvider: () => number = () => 0) {}

  private key(scopeKey: string, inputTurnId: string): string {
    return `${scopeKey}\0${inputTurnId}`;
  }

  bind(
    scopeKey: string,
    inputTurnId: string,
    callbacks: ActiveTurnOutputCallbacks,
    coordinator = new TurnOutputCoordinator(this.maxUtterancesProvider()),
  ): TurnOutputCoordinator {
    this.bindings.set(this.key(scopeKey, inputTurnId), {
      coordinator,
      callbacks,
    });
    return coordinator;
  }

  get(
    scopeKey: string,
    inputTurnId: string,
  ): TurnOutputCoordinator | undefined {
    return this.bindings.get(this.key(scopeKey, inputTurnId))?.coordinator;
  }

  stage(input: StageTurnMessageInput): StageTurnMessageResult {
    const binding = this.bindings.get(
      this.key(input.scopeKey, input.inputTurnId),
    );
    if (!binding) {
      return {
        accepted: false,
        duplicate: false,
        reason: 'inactive_turn',
      };
    }
    const prepared = binding.coordinator.prepareMessage(input.role, input.text);
    if (!prepared) {
      return { accepted: false, duplicate: false, reason: 'finalized' };
    }
    if (prepared.duplicate) return { accepted: true, duplicate: true };
    const projected =
      input.role === 'progress'
        ? binding.callbacks.onProgress(input.text)
        : binding.callbacks.onFinalCandidate(input.text);
    if (!projected) {
      return {
        accepted: false,
        duplicate: false,
        reason: 'projection_unavailable',
      };
    }
    binding.coordinator.commitPreparedMessage(prepared);
    return { accepted: true, duplicate: false };
  }

  /**
   * Record a physical, user-visible independent message against the exact
   * active input turn. Unknown or already-finalized turns are intentionally
   * ignored so a stale IPC acknowledgement cannot settle a newer turn.
   */
  recordDeliveredUtterance(input: RecordDeliveredUtteranceInput): boolean {
    const binding = this.bindings.get(
      this.key(input.scopeKey, input.inputTurnId),
    );
    if (!binding) return false;
    if (!binding.coordinator.recordDeliveredUtterance()) return false;
    binding.callbacks.onUtteranceDelivered?.();
    return true;
  }

  /**
   * Whether this turn may still emit user-visible output.
   *
   * Unknown turns return `true`: the reply fuse only governs turns this
   * registry is actually tracking, and callers such as scheduled tasks have
   * their own accounting. Suppression here must never be the reason an
   * untracked delivery path silently stops working.
   */
  canDeliverUtterance(input: RecordDeliveredUtteranceInput): boolean {
    const binding = this.bindings.get(
      this.key(input.scopeKey, input.inputTurnId),
    );
    if (!binding) return true;
    return binding.coordinator.canDeliverUtterance();
  }

  unbind(
    scopeKey: string,
    inputTurnId: string,
    coordinator?: TurnOutputCoordinator,
  ): void {
    const key = this.key(scopeKey, inputTurnId);
    if (coordinator && this.bindings.get(key)?.coordinator !== coordinator) {
      return;
    }
    this.bindings.delete(key);
  }
}
