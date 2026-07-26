import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { TurnOutputCoordinator } from '../src/turn-output-coordinator.js';
import {
  isProactiveControlPlaneSuccess,
  publishesFrameworkAnswer,
  shouldResolveFrameworkPrimaryAnswer,
} from '../src/workspace-interaction-runtime.js';
import type { InteractionMode } from '../src/types.js';

interface SuccessfulRunnerOutput {
  status: 'success';
  result: string | null;
  sourceKind?: string;
  providerFailure?: boolean;
  inputTurnCompleted?: boolean;
  newSessionId?: string;
}

function projectSuccessfulOutput(
  mode: InteractionMode,
  output: SuccessfulRunnerOutput,
  hiddenSdkText: string,
): string | null {
  const coordinator = new TurnOutputCoordinator();

  // This mirrors the production stream boundary: Proactive text never enters
  // the framework-owned answer lane, while Assistant mode retains recovery
  // from a streamed candidate when the terminal result is empty.
  if (publishesFrameworkAnswer(mode)) {
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-message',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: hiddenSdkText,
      messageUuid: 'assistant-message',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-message',
    });
  }

  if (
    isProactiveControlPlaneSuccess({
      mode,
      status: output.status,
      providerFailure: output.providerFailure,
    })
  ) {
    return null;
  }

  if (
    shouldResolveFrameworkPrimaryAnswer({
      mode,
      status: output.status,
      sourceKind: output.sourceKind,
      providerFailure: output.providerFailure,
    })
  ) {
    return coordinator.resolvePrimaryAnswer(output.result).text;
  }

  return output.result;
}

describe('Proactive SDK output boundary', () => {
  const hiddenSdkText = '这是模型循环内部的 Assistant 文本，不应作为消息展示';

  test.each([
    {
      name: 'background-task interim success',
      output: {
        status: 'success' as const,
        result: null,
        sourceKind: 'sdk_final',
        inputTurnCompleted: false,
      },
    },
    {
      name: 'healthy completed success',
      output: {
        status: 'success' as const,
        result: null,
        sourceKind: 'sdk_final',
        inputTurnCompleted: true,
      },
    },
    {
      name: 'SIGTERM session-only success',
      output: {
        status: 'success' as const,
        result: null,
        newSessionId: 'session-after-sigterm',
      },
    },
    {
      name: 'defensive suppression of a non-empty runner result',
      output: {
        status: 'success' as const,
        result: hiddenSdkText,
        sourceKind: 'sdk_final',
      },
    },
  ])('suppresses $name', ({ output }) => {
    expect(projectSuccessfulOutput('proactive', output, hiddenSdkText)).toBe(
      null,
    );
  });

  test('preserves Assistant-mode recovery from a streamed final candidate', () => {
    expect(
      projectSuccessfulOutput(
        'assistant',
        {
          status: 'success',
          result: null,
          sourceKind: 'sdk_final',
          inputTurnCompleted: true,
        },
        hiddenSdkText,
      ),
    ).toBe(hiddenSdkText);
  });

  test('wires the boundary into both main and conversation host paths', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(
      source.match(/isProactiveControlPlaneSuccess\(\{/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      source.match(/shouldResolveFrameworkPrimaryAnswer\(\{/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      source.match(
        /publishesFrameworkAnswer\(interactionMode\)\s*\?\s*[^;]*reduceStreamEvent/g,
      )?.length,
    ).toBeGreaterThanOrEqual(2);
  });
});
