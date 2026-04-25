import {
  Codex,
  type CodexOptions,
  type Input as CodexInput,
} from '@openai/codex-sdk';

import type {
  AgentRuntimeAdapter,
  RuntimeEmit,
  RuntimeRunInput,
  RuntimeRunResult,
} from './runtime-adapter.js';
import {
  buildResumeFailureRetryInput,
  classifyRuntimeError,
  runtimeContextMetaFromRunInput,
  runtimeErrorMessage,
} from './runtime-adapter.js';
import {
  buildCodexConfigObject,
  buildPrompt,
  CodexEventNormalizer,
  writeMcpContext,
  writeTempImages,
} from './codex-cli-runner.js';
import { resolveCodexPermissionOptions } from './runtime-permissions.js';

function isResumeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /resume|session|conversation|thread|not found|does not exist/i.test(
    message,
  );
}

function buildCodexInput(
  prompt: string,
  imageFiles: string[],
): CodexInput {
  if (imageFiles.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...imageFiles.map((imageFile) => ({
      type: 'local_image' as const,
      path: imageFile,
    })),
  ];
}

function configuredCodexPathOverride(): string | undefined {
  return process.env.HAPPYCLAW_CODEX_CLI_PATH || process.env.CODEX_CLI_PATH;
}

interface CodexThreadLike {
  id: string | null;
  runStreamed(
    input: CodexInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<unknown> }>;
}

interface CodexClientLike {
  startThread(options: Record<string, unknown>): CodexThreadLike;
  resumeThread(id: string, options: Record<string, unknown>): CodexThreadLike;
}

type CodexClientConstructor = new (
  options: Record<string, unknown>,
) => CodexClientLike;

export function createCodexSdkAdapter(
  CodexClient: CodexClientConstructor = Codex as unknown as CodexClientConstructor,
): AgentRuntimeAdapter {
  const adapter: AgentRuntimeAdapter = {
    runtime: 'codex',
    supportsNativeResume: true,
    supportsLiveInput: false,
    supportsPreCompactHook: false,
    canNativeResume(sessionId) {
      return !!sessionId?.trim();
    },
    classifyError: classifyRuntimeError,
    async run(
      input: RuntimeRunInput,
      emit: RuntimeEmit,
    ): Promise<RuntimeRunResult> {
    const startedAt = Date.now();
    const workspaceIpc = process.env.HAPPYCLAW_WORKSPACE_IPC || '/tmp';
    const imageFiles = writeTempImages(input.images, workspaceIpc);
    const mcpContextPath = writeMcpContext(input);
    const model = input.model || input.input.selectedModel || undefined;
    const prompt = buildPrompt(input);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }

    const codexPathOverride = configuredCodexPathOverride();
    const permissionOptions = resolveCodexPermissionOptions({
      privacyMode: !!input.input.privacyMode,
    });
    const codex = new CodexClient({
      ...(codexPathOverride ? { codexPathOverride } : {}),
      env,
      config: buildCodexConfigObject(
        mcpContextPath,
        input.cwd,
      ) as CodexOptions['config'],
    });
    const threadOptions = {
      workingDirectory: input.cwd,
      ...(input.additionalDirectories?.length
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
      skipGitRepoCheck: true,
      sandboxMode: permissionOptions.sandboxMode,
      approvalPolicy: permissionOptions.approvalPolicy,
      ...(model ? { model } : {}),
    };
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, threadOptions)
      : codex.startThread(threadOptions);

    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'status',
        statusText: 'Codex SDK 正在处理...',
      },
    });

    let newSessionId: string | undefined = input.sessionId;
    let emittedAgentMessageText = false;
    let emittedUsage = false;
    let lastAgentMessageText = '';
    let turnFailureMessage: string | null = null;
    const normalizer = new CodexEventNormalizer(emit, startedAt);

    try {
      const { events } = await thread.runStreamed(
        buildCodexInput(prompt, imageFiles),
        { signal: input.signal },
      );
      for await (const event of events) {
        const eventRecord = event as Record<string, unknown>;
        if (eventRecord.type === 'thread.started') {
          const threadId = eventRecord.thread_id;
          if (typeof threadId === 'string' && threadId.trim()) {
            newSessionId = threadId;
          }
        } else if (thread.id) {
          newSessionId = thread.id;
        }
        const normalized = normalizer.handle(eventRecord);
        if (eventRecord.type === 'turn.failed' || eventRecord.type === 'error') {
          const error = eventRecord.error as Record<string, unknown> | undefined;
          turnFailureMessage = String(
            error?.message || eventRecord.message || 'Codex turn failed',
          );
        }
        if (normalized.agentText) {
          emittedAgentMessageText = true;
          lastAgentMessageText = normalized.agentText;
        }
        if (normalized.usage) emittedUsage = true;
      }

      const result = lastAgentMessageText;
      if (result && !emittedAgentMessageText) {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'text_delta',
            text: result,
          },
        });
      }
      if (!emittedUsage) {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'usage',
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 0,
              durationMs: Date.now() - startedAt,
              numTurns: 1,
            },
          },
        });
      }
      if (turnFailureMessage) {
        return {
          status: 'error',
          result: null,
          error: `Codex SDK 执行失败：${turnFailureMessage}`,
          errorClass: classifyRuntimeError(turnFailureMessage),
          newSessionId: newSessionId || thread.id || undefined,
        };
      }

      return {
        status: 'success',
        result,
        newSessionId: newSessionId || thread.id || undefined,
      };
    } catch (error) {
      if (input.sessionId && isResumeFailure(error)) {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'status',
            statusText: 'Codex SDK resume 失败，正在用新会话重试...',
          },
        });
        const retryInput = buildResumeFailureRetryInput(
          input,
          'codex_sdk_resume_failed',
        );
        const retryResult = await adapter.run(retryInput, emit);
        return {
          ...retryResult,
          runtimeContext:
            retryResult.runtimeContext ||
            runtimeContextMetaFromRunInput(retryInput),
        };
      }

      const errorClass = classifyRuntimeError(error);
      if (errorClass === 'cancelled') {
        return {
          status: 'closed',
          result: null,
          error: runtimeErrorMessage(error),
          errorClass,
          newSessionId: newSessionId || thread.id || undefined,
        };
      }
      const message = runtimeErrorMessage(error);
      return {
        status: 'error',
        result: null,
        error: `Codex SDK 执行失败：${message}`,
        errorClass,
        newSessionId: newSessionId || thread.id || undefined,
      };
    }
  },
  };
  return adapter;
}

export const codexSdkAdapter = createCodexSdkAdapter();
