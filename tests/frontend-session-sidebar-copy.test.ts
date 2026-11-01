import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('session sidebar copy', () => {
  test('uses useful empty-state copy without repeating context implementation details', () => {
    const sidebar = [
      'web/src/components/chat/SessionSidebar.tsx',
      'web/src/lib/session-presentation.ts',
    ]
      .map(read)
      .join('\n');
    const chatView = read('web/src/components/chat/ChatView.tsx');

    expect(sidebar).not.toContain('使用独立上下文');
    expect(sidebar).toContain("messagePreview(session) || '暂无消息'");
    expect(sidebar).not.toContain("messagePreview(session) || '独立上下文'");
    // Every row is a session of its own: none stands for the workspace.
    expect(chatView).not.toContain('mainMeta=');
    expect(sidebar).not.toContain('isMain');
  });

  test('keeps Web session creation available alongside channel-native topics', () => {
    const sidebar = read('web/src/components/chat/SessionSidebar.tsx');
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const sessionActions = read('web/src/hooks/useSessionActions.ts');
    // The desktop tree creates sessions from the "+" on each workspace row.
    const sidebarTree = read(
      'web/src/components/layout/sidebar/WorkspaceTree.tsx',
    );
    const routes = read('src/routes/agents.ts');

    expect(sidebar).toContain('{canModify && onCreateSession && (');
    expect(sidebar).not.toContain(
      'canModify && !isTopicWorkspace && onCreateSession',
    );
    expect(sidebar).toContain("'新建 Web 会话'");
    expect(sidebar).toContain("const sessionNoun = '会话'");
    expect(sidebar).toContain("{title || '会话'}");
    // Its rows carry the same actions as the sidebar tree.
    expect(sidebar).toContain('menu={menuFor(session)}');
    expect(chatView).toContain('menuFor={sessionMenuFor}');
    expect(chatView).toContain('isCreatingSession={creatingSession}');
    expect(sessionActions).toContain("'创建 Web 会话失败'");
    expect(chatView).toContain('useSessionActions()');
    expect(sidebarTree).toContain("'新建 Web 会话'");
    expect(sidebarTree).toContain(
      '{nested && canModify && actions.onCreateSession && (',
    );
    expect(routes).not.toContain(
      'Native thread workspaces do not support manual sessions',
    );
    // Sessions created from the Web are manual; the factory is shared with
    // automation run sessions.
    expect(routes).toContain('createConversationSession({');
    expect(fs.readFileSync('src/session-factory.ts', 'utf8')).toContain(
      "source_kind: input.sourceKind ?? 'manual'",
    );
  });
});
