import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setupSendTool(
  toolName = 'send_message',
  contextPatch: Partial<McpContext> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-send-ack-'));
  roots.push(root);
  const context: McpContext = {
    chatJid: 'web:workspace',
    groupFolder: 'workspace',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    currentInputTurnId: 'delivery-turn-1',
    workspaceIpc: root,
    workspaceGroup: root,
    workspaceGlobal: root,
    workspaceMemory: root,
    ...contextPatch,
  };
  const sendTool = createMcpTools(context).find(
    (candidate) => candidate.name === toolName,
  );
  if (!sendTool) throw new Error(`${toolName} tool missing`);
  return { root, sendTool };
}

async function readRequest(root: string): Promise<Record<string, unknown>> {
  const messagesDir = path.join(root, 'messages');
  await vi.waitFor(() => {
    expect(fs.readdirSync(messagesDir)).toHaveLength(1);
  });
  const [file] = fs.readdirSync(messagesDir);
  return JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf8'));
}

function writeResult(
  root: string,
  requestId: string,
  payload: Record<string, unknown>,
): void {
  const resultDir = path.join(root, 'message-results');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultDir, `send_message_result_${requestId}.json`),
    JSON.stringify(payload),
  );
}

describe('send_message host acknowledgement', () => {
  test('does not report success until the host confirms real delivery', async () => {
    const { root, sendTool } = setupSendTool();
    let settled = false;
    const pending = sendTool
      .handler({ text: 'hello' }, {} as never)
      .finally(() => {
        settled = true;
      });
    const request = await readRequest(root);

    expect(request.inputTurnId).toBe('delivery-turn-1');
    expect(request.deliveryRole).toBe('final');
    expect(request.interactionMode).toBe('assistant');
    expect(typeof request.requestId).toBe('string');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    writeResult(root, request.requestId as string, { success: true });
    await expect(pending).resolves.toMatchObject({
      content: [{ type: 'text', text: 'Message sent separately.' }],
    });
  });

  test('passes an explicit progress role and reports host staging', async () => {
    const { root, sendTool } = setupSendTool();
    const pending = sendTool.handler(
      { text: '正在抓取资料', delivery_role: 'progress' },
      {} as never,
    );
    const request = await readRequest(root);
    expect(request.deliveryRole).toBe('progress');

    writeResult(root, request.requestId as string, {
      success: true,
      disposition: 'staged_progress',
    });
    await expect(pending).resolves.toMatchObject({
      content: [
        { type: 'text', text: 'Progress updated on the active reply.' },
      ],
    });
  });

  test('scheduled tasks always use separate delivery semantics', async () => {
    const { root, sendTool } = setupSendTool('send_message', {
      isScheduledTask: true,
    });
    const pending = sendTool.handler(
      { text: '定时报告', delivery_role: 'final' },
      {} as never,
    );
    const request = await readRequest(root);
    expect(request).toMatchObject({
      deliveryRole: 'separate',
      isScheduledTask: true,
      interactionMode: 'assistant',
    });
    writeResult(root, request.requestId as string, { success: true });
    await expect(pending).resolves.toBeDefined();
  });

  test('proactive turns force independent native messages regardless of requested role', async () => {
    const { root, sendTool } = setupSendTool('send_message', {
      interactionMode: 'proactive',
    });
    const pending = sendTool.handler(
      { text: '我先看一下', delivery_role: 'progress' },
      {} as never,
    );
    const request = await readRequest(root);
    expect(request).toMatchObject({
      deliveryRole: 'separate',
      interactionMode: 'proactive',
      presentation: 'native',
      inputTurnId: 'delivery-turn-1',
    });
    writeResult(root, request.requestId as string, { success: true });
    await expect(pending).resolves.toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringContaining(
            'Send again only for new, non-redundant content',
          ),
        },
      ],
    });
  });

  test('surfaces a host delivery failure instead of returning a false success', async () => {
    const { root, sendTool } = setupSendTool();
    const pending = sendTool.handler({ text: 'hello' }, {} as never);
    const request = await readRequest(root);

    writeResult(root, request.requestId as string, {
      success: false,
      error: 'connector unavailable',
    });
    await expect(pending).rejects.toThrow('connector unavailable');
  });
});

describe('scheduled media host acknowledgement', () => {
  test('send_image waits for and surfaces a physical delivery failure', async () => {
    const { root, sendTool } = setupSendTool('send_image');
    const imagePath = path.join(root, 'pixel.png');
    fs.writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0XQAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const pending = sendTool.handler(
      { file_path: imagePath, caption: 'status' },
      {} as never,
    );
    const request = await readRequest(root);
    expect(request).toMatchObject({
      type: 'image',
      filePath: 'pixel.png',
      requestId: expect.any(String),
    });
    writeResult(root, request.requestId as string, {
      success: false,
      error: 'image connector unavailable',
    });
    await expect(pending).rejects.toThrow('image connector unavailable');
  });

  test('send_file waits for the task IPC delivery result', async () => {
    const { root, sendTool } = setupSendTool('send_file');
    fs.writeFileSync(path.join(root, 'report.pdf'), 'report');
    const pending = sendTool.handler(
      { filePath: 'report.pdf', fileName: 'report.pdf' },
      {} as never,
    );
    const tasksDir = path.join(root, 'tasks');
    let requestFile = '';
    await vi.waitFor(() => {
      requestFile = fs
        .readdirSync(tasksDir)
        .find((name) => !name.includes('_result_'))!;
      expect(requestFile).toBeTruthy();
    });
    const request = JSON.parse(
      fs.readFileSync(path.join(tasksDir, requestFile), 'utf8'),
    ) as Record<string, unknown>;
    expect(request.requestId).toEqual(expect.any(String));
    fs.writeFileSync(
      path.join(
        tasksDir,
        `send_file_result_${request.requestId as string}.json`,
      ),
      JSON.stringify({ success: true }),
    );
    await expect(pending).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining('report.pdf'),
        }),
      ],
    });
  });
});
