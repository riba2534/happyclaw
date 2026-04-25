import fs from 'fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpToolCatalog, type McpContext } from './mcp-tools.js';

function readContext(): McpContext {
  const contextPath = process.argv[2];
  if (!contextPath) {
    throw new Error('Missing HappyClaw MCP context path');
  }
  const raw = fs.readFileSync(contextPath, 'utf-8');
  return JSON.parse(raw) as McpContext;
}

async function main(): Promise<void> {
  const ctx = readContext();
  const server = new McpServer({
    name: 'happyclaw',
    version: '1.0.0',
  });

  for (const tool of createMcpToolCatalog(ctx)) {
    (server as any).registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      },
      async (args: Record<string, unknown>) => {
        return await tool.handler(args as Record<string, unknown>);
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(
    `HappyClaw MCP server failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
