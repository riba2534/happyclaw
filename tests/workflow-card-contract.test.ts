import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

describe('dynamic Workflow product contract', () => {
  test('uses official SDK task metadata and output files', () => {
    const processor = fs.readFileSync(
      'container/agent-runner/src/stream-processor.ts',
      'utf8',
    );
    const projection = fs.readFileSync(
      'container/agent-runner/src/workflow-run.ts',
      'utf8',
    );

    expect(processor).toContain('task_started');
    expect(processor).toContain('task_type');
    expect(processor).toContain('workflow_name');
    expect(processor).toContain('workflowRunFromOutputFile');
    expect(projection).toContain('raw.workflowProgress');
    expect(projection).toContain('input.usage?.total_tokens');
  });

  test('renders workflow and normal answer as separate presentation regions', () => {
    const bubble = fs.readFileSync(
      'web/src/components/chat/MessageBubble.tsx',
      'utf8',
    );
    const card = fs.readFileSync(
      'web/src/components/chat/WorkflowRunCard.tsx',
      'utf8',
    );

    expect(bubble).toContain('<WorkflowRunCard');
    expect(bubble).toContain('<MarkdownRenderer');
    expect(card).toContain('动态工作流');
    expect(card).toContain('工具调用');
    expect(card).toContain('任务摘要');
    expect(card).toContain('结果摘要');
    expect(card).toContain('role="progressbar"');
    expect(card).toContain('执行信息');
    expect(card).toContain('value <= 0');
    expect(card).toContain('run.totalToolCalls > 0');
  });

  test('makes the Workflow card the only running progress surface', () => {
    const list = fs.readFileSync(
      'web/src/components/chat/MessageList.tsx',
      'utf8',
    );
    const streaming = fs.readFileSync(
      'web/src/components/chat/StreamingDisplay.tsx',
      'utf8',
    );
    const projection = fs.readFileSync(
      'container/agent-runner/src/workflow-run.ts',
      'utf8',
    );

    expect(list).toContain('isHeldBackgroundAcknowledgement');
    expect(streaming).toContain('hasWorkflowCards');
    expect(streaming).not.toContain('调用轨迹');
    expect(projection).toContain("label.includes('${')");
    expect(projection).toContain('workflowRunFromTaskProgress');
  });

  test('uses the same final-only presentation in conversation previews', () => {
    const sidebar = fs.readFileSync(
      'web/src/components/chat/SessionSidebar.tsx',
      'utf8',
    );
    const presentation = fs.readFileSync(
      'web/src/lib/session-presentation.ts',
      'utf8',
    );

    // Both the mobile list and the desktop tree preview through this helper.
    expect(sidebar).toContain("from '../../lib/session-presentation'");
    expect(presentation).toContain('getPresentedMessageContent');
  });

  test('keeps running Workflow state across a held background acknowledgement', () => {
    const backend = fs.readFileSync('src/index.ts', 'utf8');
    const store = fs.readFileSync('web/src/stores/chat.ts', 'utf8');

    expect(backend).toContain('activeWorkflowRuns');
    expect(backend).toContain('activeAgentWorkflowRuns');
    expect(backend).toContain('workflowRuns: holdReason');
    expect(backend).toContain('workflow_runs: holdReason');
    expect(backend).toContain(
      'if (!holdReason) {\n                clearStreamingSnapshot(chatJid)',
    );
    expect(store).toContain('streamingStateFromWorkflowRuns');
    expect(store).toContain('holdsRunningWorkflow');
  });
});
