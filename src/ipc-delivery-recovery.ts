import fs from 'node:fs';
import path from 'node:path';

import type { IpcDeliveryReceipt } from './group-queue.js';

const IPC_INPUT_CLAIM_MARKER = '.json.happyclaw-claimed-';

/** Runner-owned claims remain durable IPC payloads until tracker registration. */
export function isIpcInputPayloadFilename(filename: string): boolean {
  return (
    filename.endsWith('.json') || filename.includes(IPC_INPUT_CLAIM_MARKER)
  );
}

// `<request type>_result_<requestId>.json`, as written by the host's
// writeTaskResult and polled by the runner's pollIpcResult.
const IPC_TASK_RESULT_FILE_RE = /^[a-z][a-z0-9_]*_result_[A-Za-z0-9_-]+\.json$/;

/**
 * Host acknowledgements share the runner's tasks/ directory with requests,
 * which the runner names `<epoch ms>-<random>.json`. Classify results by name
 * shape instead of a per-tool allowlist, so a new IPC tool's result can never
 * be re-read as a request and unlinked before the runner polls it.
 */
export function isIpcTaskResultFile(filename: string): boolean {
  return IPC_TASK_RESULT_FILE_RE.test(filename);
}

function parseTypedDeliveryFile(filepath: string): IpcDeliveryReceipt | null {
  try {
    const payload = JSON.parse(fs.readFileSync(filepath, 'utf8')) as {
      type?: unknown;
      receipt?: {
        deliveryId?: unknown;
        chatJid?: unknown;
        coveredCursors?: Array<{
          timestamp?: unknown;
          id?: unknown;
          sequence?: unknown;
          sourceJid?: unknown;
        }>;
        cursor?: {
          timestamp?: unknown;
          id?: unknown;
          sequence?: unknown;
          sourceJid?: unknown;
        };
      };
    };
    const receipt = payload.receipt;
    if (
      payload.type !== 'message' ||
      !receipt ||
      typeof receipt.deliveryId !== 'string' ||
      typeof receipt.chatJid !== 'string' ||
      typeof receipt.cursor?.timestamp !== 'string' ||
      typeof receipt.cursor.id !== 'string'
    ) {
      return null;
    }
    return {
      deliveryId: receipt.deliveryId,
      chatJid: receipt.chatJid,
      ...(Array.isArray(receipt.coveredCursors) &&
      receipt.coveredCursors.length > 0 &&
      receipt.coveredCursors.every(
        (cursor) =>
          typeof cursor?.timestamp === 'string' &&
          typeof cursor.id === 'string',
      )
        ? {
            coveredCursors: receipt.coveredCursors.map((cursor) => ({
              timestamp: cursor.timestamp as string,
              id: cursor.id as string,
              ...(typeof cursor.sequence === 'number' &&
              Number.isSafeInteger(cursor.sequence) &&
              cursor.sequence >= 0
                ? { sequence: cursor.sequence }
                : {}),
              ...(typeof cursor.sourceJid === 'string'
                ? { sourceJid: cursor.sourceJid }
                : {}),
            })),
          }
        : {}),
      cursor: {
        timestamp: receipt.cursor.timestamp,
        id: receipt.cursor.id,
        ...(typeof receipt.cursor.sequence === 'number' &&
        Number.isSafeInteger(receipt.cursor.sequence) &&
        receipt.cursor.sequence >= 0
          ? { sequence: receipt.cursor.sequence }
          : {}),
        ...(typeof receipt.cursor.sourceJid === 'string'
          ? { sourceJid: receipt.cursor.sourceJid }
          : {}),
      },
    };
  } catch {
    return null;
  }
}

function scanInputDir(
  inputDir: string,
  recovered: Array<{ filepath: string; receipt: IpcDeliveryReceipt }>,
): void {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(inputDir).filter(isIpcInputPayloadFilename);
  } catch {
    return;
  }
  for (const filename of filenames) {
    const filepath = path.join(inputDir, filename);
    const receipt = parseTypedDeliveryFile(filepath);
    if (!receipt) continue;
    recovered.push({ filepath, receipt });
  }
}

/** Scan only user-conversation IPC namespaces. Task-run deliveries are not DB
 * chat messages and must never be replayed through this cursor protocol. */
export function discardStartupTypedIpcDeliveries(
  ipcRoot: string,
  beforeDiscard?: (receipts: IpcDeliveryReceipt[]) => void,
): IpcDeliveryReceipt[] {
  const recovered: Array<{ filepath: string; receipt: IpcDeliveryReceipt }> =
    [];
  let folders: fs.Dirent[];
  try {
    folders = fs.readdirSync(ipcRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const folderRoot = path.join(ipcRoot, folder.name);
    scanInputDir(path.join(folderRoot, 'input'), recovered);

    const agentsRoot = path.join(folderRoot, 'agents');
    let agents: fs.Dirent[];
    try {
      agents = fs.readdirSync(agentsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      scanInputDir(path.join(agentsRoot, agent.name, 'input'), recovered);
    }
  }
  const receipts = recovered.map((item) => item.receipt);
  // Persist the rewind before deleting the only crash evidence. If this
  // callback fails or the process dies, files remain for the next startup.
  beforeDiscard?.(receipts);
  for (const item of recovered) fs.unlinkSync(item.filepath);
  return receipts;
}
