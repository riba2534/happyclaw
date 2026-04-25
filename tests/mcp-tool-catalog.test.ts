import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMcpToolCatalog,
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const tmpDirs: string[] = [];

function makeContext(): McpContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mcp-catalog-'));
  tmpDirs.push(tmpDir);
  const workspaceIpc = path.join(tmpDir, 'ipc');
  const workspaceGroup = path.join(tmpDir, 'group');
  const workspaceGlobal = path.join(tmpDir, 'global');
  const workspaceMemory = path.join(tmpDir, 'memory');
  for (const dir of [
    workspaceIpc,
    workspaceGroup,
    workspaceGlobal,
    workspaceMemory,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    chatJid: 'web:mcp-catalog',
    groupFolder: 'mcp-catalog',
    isHome: true,
    isAdminHome: true,
    privacyMode: false,
    workspaceIpc,
    workspaceGroup,
    workspaceGlobal,
    workspaceMemory,
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime-neutral MCP tool catalog', () => {
  it('is the single source for Claude SDK tools and Codex MCP tools', () => {
    const ctx = makeContext();
    const catalog = createMcpToolCatalog(ctx);
    const claudeTools = createMcpTools(ctx) as Array<{ name: string }>;

    expect(catalog.map((tool) => tool.name)).toEqual(
      claudeTools.map((tool) => tool.name),
    );
    expect(catalog.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'send_message',
        'send_image',
        'send_file',
        'schedule_task',
        'list_tasks',
        'install_skill',
        'memory_append',
        'memory_search',
        'memory_get',
      ]),
    );
  });

  it('executes side-effect tools through the neutral handler', async () => {
    const ctx = makeContext();
    const sendMessage = createMcpToolCatalog(ctx).find(
      (tool) => tool.name === 'send_message',
    );
    expect(sendMessage).toBeTruthy();

    const result = await sendMessage!.handler({ text: 'hello from catalog' });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'Message sent.' }],
    });

    const messageDir = path.join(ctx.workspaceIpc, 'messages');
    const files = fs
      .readdirSync(messageDir)
      .filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(
      fs.readFileSync(path.join(messageDir, files[0]), 'utf-8'),
    );
    expect(payload).toMatchObject({
      chatJid: 'web:mcp-catalog',
      groupFolder: 'mcp-catalog',
      type: 'message',
      text: 'hello from catalog',
    });
  });
});
