// Agent definitions management routes
// Manages ~/.claude/agents/*.md files (global agent definition files)

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';

const agentDefinitionsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  updatedAt: string;
}

interface AgentDefinitionDetail extends AgentDefinition {
  content: string;
}

// --- Utility Functions ---

function getAgentsDir(): string {
  return path.join(os.homedir(), '.claude', 'agents');
}

function validateAgentId(id: string): boolean {
  return /^[\w\-]+$/.test(id);
}

function parseFrontmatter(content: string): Record<string, string | string[]> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) return {};

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const result: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let multilineMode: 'folded' | 'literal' | 'list' | null = null;

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([\w\-]+):\s*(.*)$/);
    if (keyMatch) {
      // Save previous key
      if (currentKey) {
        if (multilineMode === 'list') {
          result[currentKey] = currentValue;
        } else {
          result[currentKey] = currentValue.join(
            multilineMode === 'literal' ? '\n' : ' ',
          );
        }
      }

      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();

      if (value === '>') {
        multilineMode = 'folded';
        currentValue = [];
      } else if (value === '|') {
        multilineMode = 'literal';
        currentValue = [];
      } else if (value === '') {
        // Could be start of a list
        multilineMode = 'list';
        currentValue = [];
      } else {
        result[currentKey] = value;
        currentKey = null;
        currentValue = [];
        multilineMode = null;
      }
    } else if (currentKey && multilineMode) {
      const trimmedLine = line.trimStart();
      if (multilineMode === 'list' && trimmedLine.startsWith('- ')) {
        currentValue.push(trimmedLine.slice(2).trim());
      } else if (trimmedLine) {
        currentValue.push(trimmedLine);
      }
    }
  }

  // Save last key
  if (currentKey) {
    if (multilineMode === 'list') {
      result[currentKey] = currentValue;
    } else {
      result[currentKey] = currentValue.join(
        multilineMode === 'literal' ? '\n' : ' ',
      );
    }
  }

  return result;
}

function discoverAgents(): AgentDefinition[] {
  const agentsDir = getAgentsDir();
  if (!fs.existsSync(agentsDir)) return [];

  const agents: AgentDefinition[] = [];

  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = path.join(agentsDir, entry.name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const frontmatter = parseFrontmatter(content);
        const stats = fs.statSync(filePath);
        const id = entry.name.replace(/\.md$/, '');

        const tools = Array.isArray(frontmatter.tools)
          ? frontmatter.tools
          : typeof frontmatter.tools === 'string'
            ? frontmatter.tools.split(',').map((t) => t.trim()).filter(Boolean)
            : [];

        agents.push({
          id,
          name: (frontmatter.name as string) || id,
          description: (frontmatter.description as string) || '',
          tools,
          updatedAt: stats.mtime.toISOString(),
        });
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Directory not readable
  }

  return agents;
}

function getAgentDetail(id: string): AgentDefinitionDetail | null {
  if (!validateAgentId(id)) return null;

  const filePath = path.join(getAgentsDir(), `${id}.md`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const stats = fs.statSync(filePath);

    const tools = Array.isArray(frontmatter.tools)
      ? frontmatter.tools
      : typeof frontmatter.tools === 'string'
        ? frontmatter.tools.split(',').map((t) => t.trim()).filter(Boolean)
        : [];

    return {
      id,
      name: (frontmatter.name as string) || id,
      description: (frontmatter.description as string) || '',
      tools,
      updatedAt: stats.mtime.toISOString(),
      content,
    };
  } catch {
    return null;
  }
}

// --- Routes ---

// List all agent definitions
agentDefinitionsRoutes.get('/', authMiddleware, (c) => {
  const agents = discoverAgents();
  return c.json({ agents });
});

// Get single agent detail
agentDefinitionsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const agent = getAgentDetail(id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ agent });
});

// Update agent content
agentDefinitionsRoutes.put('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  if (!validateAgentId(id)) {
    return c.json({ error: 'Invalid agent ID' }, 400);
  }

  const filePath = path.join(getAgentsDir(), `${id}.md`);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }

  const { content } = await c.req.json<{ content: string }>();
  if (typeof content !== 'string') {
    return c.json({ error: 'content must be a string' }, 400);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return c.json({ success: true });
});

// Create new agent
agentDefinitionsRoutes.post('/', authMiddleware, async (c) => {
  const { name, content } = await c.req.json<{ name: string; content: string }>();

  if (!name || typeof name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }
  if (typeof content !== 'string') {
    return c.json({ error: 'content must be a string' }, 400);
  }

  // Derive id from name
  const id = name.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!id || !validateAgentId(id)) {
    return c.json({ error: 'Invalid agent name' }, 400);
  }

  const agentsDir = getAgentsDir();
  fs.mkdirSync(agentsDir, { recursive: true });

  const filePath = path.join(agentsDir, `${id}.md`);
  if (fs.existsSync(filePath)) {
    return c.json({ error: 'Agent with this name already exists' }, 409);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return c.json({ success: true, id });
});

// Delete agent
agentDefinitionsRoutes.delete('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  if (!validateAgentId(id)) {
    return c.json({ error: 'Invalid agent ID' }, 400);
  }

  const filePath = path.join(getAgentsDir(), `${id}.md`);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }

  fs.unlinkSync(filePath);
  return c.json({ success: true });
});

export default agentDefinitionsRoutes;
