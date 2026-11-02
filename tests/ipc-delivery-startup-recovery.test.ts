import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { discardStartupTypedIpcDeliveries } from '../src/ipc-delivery-recovery.js';

const roots: string[] = [];

function writeDelivery(
  filepath: string,
  chatJid: string,
  id: string,
  coveredIds: string[] = [id],
): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(
    filepath,
    JSON.stringify({
      type: 'message',
      text: id,
      receipt: {
        deliveryId: `delivery-${id}`,
        chatJid,
        coveredCursors: coveredIds.map((coveredId, index) => ({
          timestamp: '2026-07-10T00:00:01.000Z',
          id: coveredId,
          sequence: index + 1,
        })),
        cursor: {
          timestamp: '2026-07-10T00:00:01.000Z',
          id,
          sequence: coveredIds.length,
        },
      },
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('startup typed IPC delivery recovery', () => {
  test('deletes main/agent claims and recovers even when pull equals committed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-startup-'));
    roots.push(root);
    const mainFile = path.join(root, 'folder', 'input', 'main.json');
    const agentFile = path.join(
      root,
      'folder',
      'agents',
      'agent-1',
      'input',
      'agent.json',
    );
    const invalidFile = path.join(root, 'folder', 'input', 'legacy.json');
    writeDelivery(mainFile, 'web:main', 'm1');
    writeDelivery(agentFile, 'web:main#agent:agent-1', 'a1');
    fs.writeFileSync(
      invalidFile,
      JSON.stringify({ type: 'message', text: 'legacy' }),
    );

    let rewindPersistedBeforeDelete = false;
    const recovered = discardStartupTypedIpcDeliveries(root, () => {
      expect(fs.existsSync(mainFile)).toBe(true);
      expect(fs.existsSync(agentFile)).toBe(true);
      rewindPersistedBeforeDelete = true;
    });

    expect(recovered.map((receipt) => receipt.chatJid).sort()).toEqual([
      'web:main',
      'web:main#agent:agent-1',
    ]);
    expect(fs.existsSync(mainFile)).toBe(false);
    expect(fs.existsSync(agentFile)).toBe(false);
    expect(fs.existsSync(invalidFile)).toBe(true);
    expect(rewindPersistedBeforeDelete).toBe(true);
  });

  test('does not delete crash evidence when durable rewind fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-startup-fail-'));
    roots.push(root);
    const deliveryFile = path.join(root, 'folder', 'input', 'main.json');
    writeDelivery(deliveryFile, 'web:main', 'm1');

    expect(() =>
      discardStartupTypedIpcDeliveries(root, () => {
        throw new Error('persist failed');
      }),
    ).toThrow('persist failed');
    expect(fs.existsSync(deliveryFile)).toBe(true);
  });

  test('preserves an exact batch cursor set while startup orders DB replay', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-startup-batch-'));
    roots.push(root);
    const deliveryFile = path.join(root, 'folder', 'input', 'batch.json');
    writeDelivery(deliveryFile, 'web:main', 'm2', ['m1', 'm2']);

    const recovered = discardStartupTypedIpcDeliveries(root);

    expect(recovered).toHaveLength(1);
    expect(recovered[0].coveredCursors?.map((cursor) => cursor.id)).toEqual([
      'm1',
      'm2',
    ]);
    expect(recovered[0].cursor.id).toBe('m2');
    expect(recovered[0].cursor.sequence).toBe(2);
    expect(fs.existsSync(deliveryFile)).toBe(false);
  });

  test('treats a Runner crash claim as the same durable startup delivery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-startup-claim-'));
    roots.push(root);
    const claimedFile = path.join(
      root,
      'folder',
      'agents',
      'agent-1',
      'input',
      'pending.json.happyclaw-claimed-123-1-test',
    );
    writeDelivery(claimedFile, 'web:main#agent:agent-1', 'a1');

    const recovered = discardStartupTypedIpcDeliveries(root);

    expect(recovered.map((receipt) => receipt.deliveryId)).toEqual([
      'delivery-a1',
    ]);
    expect(fs.existsSync(claimedFile)).toBe(false);
  });
});
