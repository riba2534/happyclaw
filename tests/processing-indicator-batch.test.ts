import { describe, expect, test } from 'vitest';

import {
  isProviderAcknowledgeableInputId,
  selectBatchProcessingIndicatorOwners,
} from '../src/processing-indicator-batch.js';

describe('batch processing indicator ownership', () => {
  test('selects only the latest Feishu input in one executing batch', () => {
    expect(
      selectBatchProcessingIndicatorOwners([
        { id: 'om_first', sourceJid: 'feishu:chat#thread:one' },
        { id: 'om_second', sourceJid: 'feishu:chat#thread:one' },
      ]),
    ).toEqual([
      {
        inputTurnId: 'om_second',
        transportJid: 'feishu:chat#thread:one',
      },
    ]);
  });

  test('keeps independent non-Feishu ingress acknowledgements exact', () => {
    expect(
      selectBatchProcessingIndicatorOwners([
        { id: 'telegram-a', sourceJid: 'telegram:chat' },
        { id: 'telegram-b', sourceJid: 'telegram:chat' },
      ]),
    ).toEqual([
      { inputTurnId: 'telegram-a', transportJid: 'telegram:chat' },
      { inputTurnId: 'telegram-b', transportJid: 'telegram:chat' },
    ]);
  });

  test('does not mirror an explicit Web input to a sticky IM fallback', () => {
    expect(
      selectBatchProcessingIndicatorOwners(
        [{ id: 'web-input', sourceJid: 'web:main' }],
        'feishu:chat',
      ),
    ).toEqual([]);
  });

  test('uses the active Feishu route when a warm cursor omits its source', () => {
    expect(
      selectBatchProcessingIndicatorOwners(
        [{ id: 'om_first' }, { id: 'om_second' }],
        'feishu:chat#thread:one',
      ),
    ).toEqual([
      {
        inputTurnId: 'om_second',
        transportJid: 'feishu:chat#thread:one',
      },
    ]);
  });

  test('never selects a synthetic input id as the Feishu reaction target', () => {
    // A scheduled group prompt routed to a Feishu chat has no provider
    // message; reacting to it is Feishu 99992354 "Invalid ids".
    expect(
      selectBatchProcessingIndicatorOwners(
        [{ id: 'scheduled-task-prompt:run-1' }],
        'feishu:oc_group',
      ),
    ).toEqual([]);
    // The latest *real* Feishu input owns the batch, not a later synthetic id.
    expect(
      selectBatchProcessingIndicatorOwners(
        [
          { id: 'om_user', sourceJid: 'feishu:oc_group' },
          { id: 'scheduled-task-prompt:run-2' },
          { id: '6f1c2e9a-1d3b-4f4f-9d1e-2b3c4d5e6f70' },
        ],
        'feishu:oc_group',
      ),
    ).toEqual([{ inputTurnId: 'om_user', transportJid: 'feishu:oc_group' }]);
  });

  test('provider acknowledgement ids', () => {
    expect(isProviderAcknowledgeableInputId('feishu:oc_x', 'om_abc_123')).toBe(
      true,
    );
    expect(isProviderAcknowledgeableInputId('feishu:oc_x', 'web-uuid')).toBe(
      false,
    );
    expect(
      isProviderAcknowledgeableInputId(
        'telegram:42',
        'scheduled-task-prompt:run',
      ),
    ).toBe(false);
    expect(isProviderAcknowledgeableInputId('telegram:42', '12345')).toBe(true);
  });
});
