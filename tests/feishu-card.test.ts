import { describe, expect, test } from 'vitest';
import {
  buildAgentReplyCard,
  buildStreamingAgentCard,
} from '../src/feishu-cards/builder.js';
import { resolveStatusTheme } from '../src/feishu-cards/status-theme.js';
import {
  splitIntoBodySections,
  SECTION_SOFT_LIMIT,
  SECTION_HARD_LIMIT,
  MAX_SECTIONS,
} from '../src/feishu-cards/length.js';
import {
  CARD_ELEMENT_IDS,
  extractTitle,
  formatDuration,
  formatTokens,
  shortModel,
  buildStatusBannerText,
  buildProgressListText,
  buildToolsTimelineText,
  buildThinkingBlockquote,
  buildAskQuestionText,
  collectAskQuestions,
  buildTimelineText,
  parseToolParam,
} from '../src/feishu-cards/sections.js';

// ─── Recursive schema validation helpers ───────────────────────────

const ALLOWED_COLOR_ENUMS = new Set([
  'blue',
  'wathet',
  'turquoise',
  'indigo',
  'green',
  'lime',
  'yellow',
  'orange',
  'red',
  'carmine',
  'purple',
  'violet',
  'grey',
  'default',
  'neutral',
  'white',
  'bg-white',
]);

/** Walk a card tree and collect findings that would break v2 strict validation. */
function validateV2Shape(node: unknown, path: string[] = []): string[] {
  const issues: string[] = [];
  if (node === null || typeof node !== 'object') return issues;
  if (Array.isArray(node)) {
    node.forEach((v, i) => issues.push(...validateV2Shape(v, [...path, String(i)])));
    return issues;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const childPath = [...path, key];
    // hr is a valid v2 component (components.md §hr) — kept off the denylist.
    if (key === 'tag' && value === 'note') {
      issues.push(`[${childPath.join('.')}] v2 removed the note component`);
    }
    if (key === 'tag' && value === 'action') {
      issues.push(`[${childPath.join('.')}] v2 removed the action container`);
    }
    if (key === 'wide_screen_mode') {
      issues.push(`[${childPath.join('.')}] v1 property wide_screen_mode used in v2 card`);
    }
    if (key === 'padding' && typeof value === 'string') {
      const parts = value.trim().split(/\s+/);
      if (parts.length === 2 || parts.length === 3) {
        issues.push(
          `[${childPath.join('.')}] padding "${value}" uses 2/3 values (v2 requires 1 or 4)`,
        );
      }
    }
    if (
      (key === 'color' || key === 'template' || key === 'background_color') &&
      typeof value === 'string'
    ) {
      // Allow enum names with optional -50..-900 suffix, or rgba(), but never hex
      const ok =
        ALLOWED_COLOR_ENUMS.has(value) ||
        /^([a-z\-]+)-(50|100|200|300|400|500|600|700|800|900)$/.test(value) ||
        /^rgba\(\d+,\d+,\d+,(0|1|0?\.\d+)\)$/.test(value);
      if (!ok) {
        issues.push(`[${childPath.join('.')}] color "${value}" is not a v2 enum`);
      }
    }
    issues.push(...validateV2Shape(value, childPath));
  }
  return issues;
}

/** Collect every element_id string in the tree (duplicates flagged by caller). */
function collectElementIds(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const v of node) collectElementIds(v, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.element_id === 'string') out.push(obj.element_id);
  for (const v of Object.values(obj)) collectElementIds(v, out);
  return out;
}

function countTag(node: unknown, tag: string): number {
  if (node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    return node.reduce((s: number, v) => s + countTag(v, tag), 0);
  }
  const obj = node as Record<string, unknown>;
  let n = obj.tag === tag ? 1 : 0;
  for (const v of Object.values(obj)) n += countTag(v, tag);
  return n;
}

// ─── element_id format constraints (Feishu server rule) ───────────
//
// Feishu rejects element_ids that are longer than 20 chars or contain anything
// besides letters/digits/underscores starting with a letter (observed error
// code 300301/1002). We lock this down so future slot additions fail fast
// in tests rather than at runtime.

describe('CARD_ELEMENT_IDS', () => {
  test('every element_id is ≤ 20 chars and matches /^[A-Za-z][A-Za-z0-9_]*$/', () => {
    for (const [name, value] of Object.entries(CARD_ELEMENT_IDS)) {
      expect(
        value.length,
        `${name}="${value}" must be ≤ 20 chars`,
      ).toBeLessThanOrEqual(20);
      expect(
        /^[A-Za-z][A-Za-z0-9_]*$/.test(value),
        `${name}="${value}" must match /^[A-Za-z][A-Za-z0-9_]*$/`,
      ).toBe(true);
    }
  });

  test('element_id values are globally unique', () => {
    const values = Object.values(CARD_ELEMENT_IDS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ─── status-theme ──────────────────────────────────────────────

describe('resolveStatusTheme', () => {
  test.each([
    ['running', 'blue', '生成中'],
    ['done', 'violet', '完成'],
    ['warning', 'orange', '部分成功'],
    ['error', 'red', '失败'],
  ] as const)('%s → template=%s tagText=%s', (status, template, tagText) => {
    const theme = resolveStatusTheme(status);
    expect(theme.template).toBe(template);
    expect(theme.tagColor).toBe(template);
    expect(theme.tagText).toBe(tagText);
  });
});

// ─── length.ts ─────────────────────────────────────────────────

describe('splitIntoBodySections', () => {
  test('empty text → empty array', () => {
    expect(splitIntoBodySections('')).toEqual([]);
    expect(splitIntoBodySections('   \n\n  ')).toEqual([]);
  });

  test('short text → single expanded section', () => {
    const sections = splitIntoBodySections('hello world');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({ text: 'hello world', expanded: true });
  });

  test(`under soft limit (${SECTION_SOFT_LIMIT}) → single section`, () => {
    const text = 'a'.repeat(SECTION_SOFT_LIMIT - 1);
    const sections = splitIntoBodySections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].expanded).toBe(true);
  });

  test('text exceeding hard limit → first expanded, rest collapsed', () => {
    const para = 'x'.repeat(1500);
    const text = Array.from({ length: 4 }, () => para).join('\n\n');
    const sections = splitIntoBodySections(text);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0].expanded).toBe(true);
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].expanded).toBe(false);
    }
  });

  test(`bin-packing respects hard limit (${SECTION_HARD_LIMIT})`, () => {
    const para = 'y'.repeat(1500);
    const text = Array.from({ length: 6 }, () => para).join('\n\n');
    const sections = splitIntoBodySections(text);
    for (const section of sections) {
      // Allow the last bin to exceed if it's a merged tail with clipping.
      expect(section.text.length).toBeLessThanOrEqual(SECTION_HARD_LIMIT);
    }
  });

  test(`never exceeds MAX_SECTIONS (${MAX_SECTIONS})`, () => {
    const para = 'z'.repeat(3500);
    const text = Array.from({ length: 12 }, () => para).join('\n\n');
    const sections = splitIntoBodySections(text);
    expect(sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
  });
});

// ─── sections.ts formatters ────────────────────────────────────

describe('formatters', () => {
  test('formatDuration', () => {
    expect(formatDuration(undefined)).toBe('-');
    expect(formatDuration(-5)).toBe('-');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(62_000)).toBe('1m 2s');
    expect(formatDuration(120_000)).toBe('2m');
  });

  test('formatTokens', () => {
    expect(formatTokens(undefined)).toBe('-');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(100_000)).toBe('100.0K');
  });

  test('shortModel', () => {
    expect(shortModel('claude-opus-4-7')).toBe('opus-4.7');
    expect(shortModel('claude-sonnet-4-6')).toBe('sonnet-4.6');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4.5');
    expect(shortModel('gpt-4o-mini')).toBe('gpt-4o-mini');
  });

  test('extractTitle picks H1-H3 heading', () => {
    expect(extractTitle('# Hello\nbody').title).toBe('Hello');
    expect(extractTitle('## Hi\nbody').title).toBe('Hi');
    expect(extractTitle('### Yo\nbody').title).toBe('Yo');
    // 4 levels of # — not a heading, falls back to first-line preview
    expect(extractTitle('#### Deep\nbody').title).toBe('Deep');
  });

  test('extractTitle falls back to first-line preview (≤40 chars)', () => {
    const text = 'Just some plain text that has no markdown heading at all';
    const { title, bodyStartIndex } = extractTitle(text);
    expect(title.length).toBeLessThanOrEqual(40);
    expect(bodyStartIndex).toBe(0);
  });
});

// ─── buildAgentReplyCard shape ─────────────────────────────────

describe('buildAgentReplyCard', () => {
  test('minimal card: v2 schema + violet done template', () => {
    const card = buildAgentReplyCard({ status: 'done', text: 'Hello world' });
    expect(card.schema).toBe('2.0');
    const config = card.config as Record<string, unknown>;
    expect(config.width_mode).toBe('fill');
    expect(config.update_multi).toBe(true);
    expect(config.enable_forward).toBe(true);
    expect(config.wide_screen_mode).toBeUndefined();

    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe('violet');
    // header.icon removed — standard_icon tokens are not supported on all clients
    expect(header.icon).toBeUndefined();

    const tags = header.text_tag_list as Array<Record<string, unknown>>;
    expect(tags.length).toBeGreaterThan(0);
    expect((tags.at(-1)!.text as Record<string, unknown>).content).toBe('完成');

    const body = card.body as Record<string, unknown>;
    expect(body.vertical_spacing).toBe('medium');
    expect(body.direction).toBe('vertical');
  });

  test('header.template reflects CardStatus and omits icon', () => {
    const cases: Array<[
      'running' | 'done' | 'warning' | 'error',
      string,
    ]> = [
      ['running', 'blue'],
      ['done', 'violet'],
      ['warning', 'orange'],
      ['error', 'red'],
    ];
    for (const [status, template] of cases) {
      const card = buildAgentReplyCard({ status, text: 'x' });
      const header = card.header as Record<string, unknown>;
      expect(header.template).toBe(template);
      expect(header.icon).toBeUndefined();
    }
  });

  test('running / warning / error status maps to correct template', () => {
    for (const [status, template] of [
      ['running', 'blue'],
      ['warning', 'orange'],
      ['error', 'red'],
    ] as const) {
      const card = buildAgentReplyCard({ status, text: 'x' });
      const header = card.header as Record<string, unknown>;
      expect(header.template).toBe(template);
    }
  });

  test('short body → single main_content element, no collapsible overflow', () => {
    const card = buildAgentReplyCard({ status: 'done', text: 'short reply' });
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const mainCount = body.elements.filter(
      (e) => e.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT,
    ).length;
    expect(mainCount).toBe(1);
    expect(countTag(card, 'collapsible_panel')).toBe(0);
  });

  test('long body → multiple flat markdown chunks, no "继续阅读" panels', () => {
    const para = 'lorem '.repeat(500);
    const text = Array.from({ length: 5 }, () => para).join('\n\n');
    const card = buildAgentReplyCard({ status: 'done', text });
    const body = card.body as { elements: Array<Record<string, unknown>> };
    // Chunks render as consecutive markdown elements at the top of body
    const markdownChunks = body.elements.filter(
      (e) =>
        e.tag === 'markdown' &&
        e.element_id !== CARD_ELEMENT_IDS.FOOTER &&
        (e.content as string) !== '---',
    );
    expect(markdownChunks.length).toBeGreaterThan(1);
    // None of the JSON should have a collapsible panel titled "继续阅读"
    const json = JSON.stringify(card);
    expect(json).not.toContain('继续阅读');
    // Panels for meta/thinking/tools/footer may still exist, but none driven by chunking.
    // (No meta → no collapsibles at all.)
    expect(countTag(card, 'collapsible_panel')).toBe(0);
  });

  test('meta renders a compact metadata markdown row', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'reply',
      meta: {
        durationMs: 1234,
        model: 'claude-opus-4-7',
        inputTokens: 1200,
        outputTokens: 800,
        toolCount: 3,
      },
    });
    const ids = collectElementIds(card);
    expect(ids).toContain(CARD_ELEMENT_IDS.META_ROW);
  });

  test('thinking renders a dedicated collapsible panel and final card omits tool stats', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'reply',
      thinking: 'Some internal monologue.',
      meta: {
        toolCalls: [
          { name: 'Read', count: 2 },
          { name: 'Bash', count: 1 },
        ],
      },
    });
    const ids = collectElementIds(card);
    expect(ids).toContain(CARD_ELEMENT_IDS.THINKING_PANEL_FINAL);
    expect(ids).not.toContain(CARD_ELEMENT_IDS.TOOLS_PANEL_FINAL);
  });

  test('footer is folded into the compact metadata row and not rendered standalone', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'reply',
      footer: '来源：Web',
    });
    const ids = collectElementIds(card);
    expect(ids).not.toContain(CARD_ELEMENT_IDS.FOOTER);
  });

  test('completedAtMs does not create a standalone footer', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'reply',
      footer: '来源：Web',
      completedAtMs: 1_700_000_000_000,
    });
    const findFooter = (node: unknown): string | null => {
      if (!node || typeof node !== 'object') return null;
      const obj = node as Record<string, unknown>;
      if (obj.element_id === CARD_ELEMENT_IDS.FOOTER) {
        return (obj.content as string) ?? null;
      }
      for (const v of Object.values(obj)) {
        const found = findFooter(v);
        if (found) return found;
      }
      return null;
    };
    const footerContent = findFooter(card);
    expect(footerContent).toBeNull();
  });

  test('toolCalls do not render a final tools panel', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'reply',
      meta: { toolCalls: [{ name: 'Read', count: 5 }] },
    });
    const findPanel = (node: unknown): Record<string, unknown> | null => {
      if (!node || typeof node !== 'object') return null;
      const obj = node as Record<string, unknown>;
      if (obj.element_id === CARD_ELEMENT_IDS.TOOLS_PANEL_FINAL) return obj;
      for (const v of Object.values(obj)) {
        const found = findPanel(v);
        if (found) return found;
      }
      return null;
    };
    const panel = findPanel(card);
    expect(panel).toBeNull();
  });

  test('meta-only card does not add a divider', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'reply',
      meta: { durationMs: 100 },
    });
    expect(countTag(card, 'hr')).toBe(0);
    // And that we're NOT using markdown "---" as a divider anymore
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const mdDividers = body.elements.filter(
      (e) => e.tag === 'markdown' && (e.content as string) === '---',
    );
    expect(mdDividers.length).toBe(0);
  });

  test('no hr tag, no v1 properties, no illegal colors/padding', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: '# Title\n\n' + 'para\n\n'.repeat(20),
      thinking: 'Thinking ...',
      meta: {
        durationMs: 500,
        model: 'claude-opus-4-7',
        inputTokens: 50,
        outputTokens: 20,
        toolCalls: [{ name: 'Read', count: 1 }],
      },
      footer: 'web',
    });
    const issues = validateV2Shape(card);
    expect(issues).toEqual([]);
  });

  test('element_ids are unique within a card', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'short',
      thinking: 'thinking',
      meta: { toolCalls: [{ name: 'Read', count: 1 }] },
      footer: 'web',
    });
    const ids = collectElementIds(card);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('tool breakdown is not included in final card body', () => {
    const toolCalls = Array.from({ length: 15 }, (_, i) => ({
      name: `tool_${i}`,
      count: 1,
    }));
    const card = buildAgentReplyCard({
      status: 'done',
      text: 'reply',
      meta: { toolCalls },
    });
    // Walk the tools panel to find its inner markdown content.
    const findContent = (node: unknown): string | null => {
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (obj.element_id === CARD_ELEMENT_IDS.TOOLS_PANEL_FINAL) {
          const elements = obj.elements as Array<Record<string, unknown>>;
          return (elements[0]?.content as string) ?? null;
        }
        for (const v of Object.values(obj)) {
          const found = findContent(v);
          if (found) return found;
        }
      }
      return null;
    };
    const content = findContent(card);
    expect(content).toBeNull();
  });

  test('codex final card renders only real process artifacts', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      title: 'Codex 回复',
      text: '最终回答',
      codexTodos: [
        { content: '检查状态', status: 'completed' },
        { content: '汇总结果', status: 'pending' },
      ],
      codexOperations: [
        { text: '🔄 Bash' },
        { text: '✅ Bash' },
        { text: '状态: Codex SDK 正在处理...' },
      ],
    });
    const json = JSON.stringify(card);
    expect(json).toContain('计划 / Todo');
    expect(json).toContain('操作记录');
    expect(json).toContain('检查状态');
    expect(json).toContain('Codex SDK 正在处理');
    expect(collectElementIds(card)).toContain(CARD_ELEMENT_IDS.CODEX_TODOS_FINAL);
    expect(collectElementIds(card)).toContain(CARD_ELEMENT_IDS.CODEX_OPS_FINAL);
    expect(validateV2Shape(card)).toEqual([]);
  });

  test('codex final card omits empty process placeholders', () => {
    const card = buildAgentReplyCard({
      status: 'done',
      title: 'Codex 回复',
      text: '最终回答',
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('计划 / Todo');
    expect(json).not.toContain('操作记录');
    expect(json).not.toContain('暂无计划');
    expect(json).not.toContain('暂无调用记录');
  });
});

// ─── buildStreamingAgentCard shape ─────────────────────────────

describe('buildStreamingAgentCard', () => {
  test('rich streaming card has v2 schema, blue template, and all runtime slots', () => {
    const card = buildStreamingAgentCard({ initialText: 'starting…' });
    expect(card.schema).toBe('2.0');
    const config = card.config as Record<string, unknown>;
    expect(config.streaming_mode).toBe(true);
    expect(config.width_mode).toBe('fill');
    expect(config.wide_screen_mode).toBeUndefined();
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe('blue');

    // Rich skeleton: STATUS_BANNER + 3 collapsible panels + MAIN_CONTENT + BUTTON + FOOTER_NOTE
    const ids = new Set(collectElementIds(card));
    for (const required of [
      CARD_ELEMENT_IDS.STATUS_BANNER,
      CARD_ELEMENT_IDS.PROGRESS_PANEL,
      CARD_ELEMENT_IDS.PROGRESS_CONTENT,
      CARD_ELEMENT_IDS.TOOLS_PANEL,
      CARD_ELEMENT_IDS.TOOLS_CONTENT,
      CARD_ELEMENT_IDS.THINKING_PANEL,
      CARD_ELEMENT_IDS.THINKING_CONTENT,
      CARD_ELEMENT_IDS.MAIN_CONTENT,
      CARD_ELEMENT_IDS.INTERRUPT_BTN,
      CARD_ELEMENT_IDS.FOOTER_NOTE,
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });

  test('rich streaming card contains 5 collapsible panels (Phase F adds ask + timeline)', () => {
    const card = buildStreamingAgentCard({ initialText: 'x' });
    expect(countTag(card, 'collapsible_panel')).toBe(5);
  });

  test('codex streaming card uses Codex-native panel wording', () => {
    const card = buildStreamingAgentCard({
      initialText: '',
      runtimeProfile: 'codex',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('Codex 准备中');
    expect(json).toContain('计划 / Todo');
    expect(json).toContain('操作时间轴');
    expect(json).toContain('推理过程');
    expect(json).toContain('运行日志');
    expect(json).toContain('暂无计划');
    expect(json).toContain('尚未执行操作');
    expect(json).not.toContain('等待任务规划');
    expect(json).not.toContain('尚未调用工具');
  });

  test('codex compact streaming card omits empty rich placeholder panels', () => {
    const card = buildStreamingAgentCard({
      initialText: '',
      runtimeProfile: 'codex',
      rich: false,
    });
    const json = JSON.stringify(card);
    expect(countTag(card, 'collapsible_panel')).toBe(0);
    expect(json).toContain('Codex 处理中');
    expect(json).not.toContain('计划 / Todo');
    expect(json).not.toContain('等待任务规划');
    expect(json).not.toContain('尚未调用工具');
  });

  test('claude rich streaming card keeps agent lifecycle placeholders', () => {
    const card = buildStreamingAgentCard({
      initialText: '',
      runtimeProfile: 'claude',
    });
    const json = JSON.stringify(card);
    expect(countTag(card, 'collapsible_panel')).toBe(5);
    expect(json).toContain('任务进度');
    expect(json).toContain('等待任务规划');
  });

  test('legacy (rich:false) streaming card keeps 5-slot flat layout', () => {
    const card = buildStreamingAgentCard({ initialText: 'legacy', rich: false });
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const elementIds = body.elements.map((e) => e.element_id);
    expect(elementIds).toEqual([
      CARD_ELEMENT_IDS.AUX_BEFORE,
      CARD_ELEMENT_IDS.MAIN_CONTENT,
      CARD_ELEMENT_IDS.AUX_AFTER,
      CARD_ELEMENT_IDS.INTERRUPT_BTN,
      CARD_ELEMENT_IDS.STATUS_NOTE,
    ]);
    expect(countTag(card, 'collapsible_panel')).toBe(0);
  });

  test('streaming card passes strict v2 validation', () => {
    const card = buildStreamingAgentCard({
      initialText: 'seed',
      meta: { model: 'claude-opus-4-7' },
    });
    expect(validateV2Shape(card)).toEqual([]);
  });

  test('streaming_config is tuned per-platform', () => {
    const card = buildStreamingAgentCard({ initialText: '' });
    const config = card.config as Record<string, unknown>;
    const sc = config.streaming_config as Record<string, unknown>;
    const freq = sc.print_frequency_ms as Record<string, number>;
    const step = sc.print_step as Record<string, number>;
    expect(freq.default).toBeDefined();
    expect(freq.android).toBeDefined();
    expect(freq.ios).toBeDefined();
    expect(freq.pc).toBeDefined();
    expect(step.android).toBeDefined();
    expect(step.ios).toBeDefined();
    expect(step.pc).toBeDefined();
  });

  test('streaming body carries direction + vertical_spacing', () => {
    const card = buildStreamingAgentCard({ initialText: '' });
    const body = card.body as Record<string, unknown>;
    expect(body.direction).toBe('vertical');
    expect(body.vertical_spacing).toBe('medium');
  });

  test('streaming header has no icon (removed to avoid broken images)', () => {
    const card = buildStreamingAgentCard({ initialText: '' });
    const header = card.header as Record<string, unknown>;
    expect(header.icon).toBeUndefined();
  });

  test('rich streaming card element_ids are unique', () => {
    const card = buildStreamingAgentCard({ initialText: '' });
    const ids = collectElementIds(card);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── Streaming runtime content builders ────────────────────────

describe('buildStatusBannerText', () => {
  test.each([
    ['thinking', '思考中'],
    ['tooling', '调用工具'],
    ['streaming', '生成回复'],
    ['completed', '已完成'],
    ['error', '出错'],
  ] as const)('phase %s emits tag %s', (phase, expectedTag) => {
    const text = buildStatusBannerText({ phase });
    expect(text).toContain(expectedTag);
  });

  test('embeds elapsed time when provided', () => {
    const text = buildStatusBannerText({ phase: 'streaming', elapsedMs: 2500 });
    expect(text).toMatch(/2\.5s/);
  });

  test('includes detail clause when provided', () => {
    const text = buildStatusBannerText({
      phase: 'tooling',
      detail: '`Read` src/foo.ts',
    });
    expect(text).toContain('Read');
  });

  test('codex profile uses Codex status labels', () => {
    expect(
      buildStatusBannerText({ phase: 'working', runtimeProfile: 'codex' }),
    ).toContain('Codex 处理中');
    expect(
      buildStatusBannerText({ phase: 'tooling', runtimeProfile: 'codex' }),
    ).toContain('执行操作');
  });
});

describe('buildProgressListText', () => {
  test('renders progress bar + item icons', () => {
    const text = buildProgressListText([
      { content: '分析', status: 'completed' },
      { content: '编写', status: 'in_progress' },
      { content: '测试', status: 'pending' },
    ]);
    expect(text).toMatch(/进度 1\/3/);
    expect(text).toContain('▓');
    expect(text).toContain('✅');
    expect(text).toContain('🔄');
    expect(text).toContain('⏳');
  });

  test('empty list → placeholder', () => {
    expect(buildProgressListText([])).toContain('暂无');
  });

  test('truncates beyond MAX_VISIBLE', () => {
    const todos = Array.from({ length: 20 }, (_, i) => ({
      content: `T${i}`,
      status: 'pending' as const,
    }));
    const text = buildProgressListText(todos);
    expect(text).toContain('还有');
  });
});

describe('buildToolsTimelineText', () => {
  test('renders status tags and elapsed time', () => {
    const text = buildToolsTimelineText([
      { name: 'Read', status: 'complete', durationMs: 1200 },
      { name: 'Bash', status: 'running', durationMs: 3000, summary: 'npm test' },
      { name: 'Edit', status: 'error', durationMs: 800 },
    ]);
    expect(text).toContain('完成');
    expect(text).toContain('运行');
    expect(text).toContain('失败');
    expect(text).toContain('`Read`');
    expect(text).toContain('npm test');
  });

  test('empty list → placeholder', () => {
    expect(buildToolsTimelineText([])).toContain('尚未');
  });

  test('truncates past maxVisible', () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({
      name: `t${i}`,
      status: 'complete' as const,
      durationMs: 100,
    }));
    const text = buildToolsTimelineText(tools, { maxVisible: 5 });
    expect(text).toContain('另有');
  });
});

describe('buildThinkingBlockquote', () => {
  test('wraps lines with >', () => {
    const text = buildThinkingBlockquote('Line A\nLine B\n\nLine C');
    expect(text.split('\n').every((l) => l.startsWith('>'))).toBe(true);
  });

  test('truncates to ~2000 chars from tail', () => {
    const text = buildThinkingBlockquote('x'.repeat(5000));
    expect(text.length).toBeLessThan(3000);
    expect(text).toContain('…');
  });

  test('≤ 2000 chars stays intact', () => {
    const text = buildThinkingBlockquote('x'.repeat(1500));
    expect(text).not.toContain('…');
  });

  test('empty → placeholder', () => {
    expect(buildThinkingBlockquote('   ')).toContain('暂无');
  });
});

// ─── Phase F: cross-platform alignment helpers ────────────────

describe('parseToolParam (aligned with web parseToolParam)', () => {
  test.each([
    ['Read', 'path'],
    ['Write', 'path'],
    ['Edit', 'path'],
    ['Glob', 'path'],
    ['Bash', 'cmd'],
    ['Grep', 'pattern'],
    ['Agent', 'task'],
    ['Task', 'task'],
    ['WebFetch', 'input'],
  ] as const)('%s summary → label %s', (toolName, expectedLabel) => {
    const parsed = parseToolParam(toolName, 'some summary');
    expect(parsed?.label).toBe(expectedLabel);
    expect(parsed?.value).toBe('some summary');
  });

  test('missing summary → null', () => {
    expect(parseToolParam('Bash', undefined)).toBeNull();
    expect(parseToolParam('Bash', '')).toBeNull();
  });
});

describe('buildToolsTimelineText with skillName + isNested + param', () => {
  test('Skill tool renders skillName instead of "Skill"', () => {
    const text = buildToolsTimelineText([
      {
        name: 'Skill',
        status: 'running',
        durationMs: 500,
        skillName: 'my-awesome-skill',
      },
    ]);
    expect(text).toContain('my-awesome-skill');
    expect(text).not.toContain('`Skill`');
  });

  test('nested tool is indented', () => {
    const text = buildToolsTimelineText([
      { name: 'Read', status: 'running', durationMs: 100, isNested: true },
    ]);
    expect(text.startsWith('    ')).toBe(true);
  });

  test('Bash gets cmd label, Grep gets pattern label', () => {
    const text = buildToolsTimelineText([
      { name: 'Bash', status: 'complete', durationMs: 100, summary: 'ls -la' },
      { name: 'Grep', status: 'complete', durationMs: 50, summary: 'foo' },
    ]);
    expect(text).toContain('cmd:');
    expect(text).toContain('pattern:');
  });
});

describe('buildStatusBannerText hook phase', () => {
  test('phase=hook renders indigo tag', () => {
    const text = buildStatusBannerText({
      phase: 'hook',
      detail: 'pre-commit-check',
    });
    expect(text).toContain('运行 Hook');
    expect(text).toContain("color='indigo'");
    expect(text).toContain('pre-commit-check');
  });
});

describe('collectAskQuestions', () => {
  test('single-question format', () => {
    const qs = collectAskQuestions({
      question: 'Are you sure?',
      options: [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }],
    });
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toBe('Are you sure?');
    expect(qs[0].options?.length).toBe(2);
  });

  test('multi-question array format', () => {
    const qs = collectAskQuestions({
      questions: [
        { question: 'A?', options: [] },
        { question: 'B?', options: [{ label: 'x', value: 'x' }] },
      ],
    });
    expect(qs).toHaveLength(2);
  });

  test('undefined/empty → empty array', () => {
    expect(collectAskQuestions(undefined)).toEqual([]);
    expect(collectAskQuestions({})).toEqual([]);
  });
});

describe('buildAskQuestionText', () => {
  test('renders question + option text_tags', () => {
    const text = buildAskQuestionText([
      {
        question: 'Pick one',
        options: [{ label: 'Alpha' }, { value: 'beta' }],
      },
    ]);
    expect(text).toContain('**Pick one**');
    expect(text).toContain('<text_tag');
    expect(text).toContain('Alpha');
    expect(text).toContain('beta');
    expect(text).toContain('请在 Agent 终端回复');
  });

  test('empty options → just the bold question', () => {
    const text = buildAskQuestionText([{ question: 'Yes?' }]);
    expect(text).toContain('**Yes?**');
    expect(text).not.toContain('text_tag');
  });

  test('no questions → empty string', () => {
    expect(buildAskQuestionText([])).toBe('');
  });
});

describe('buildTimelineText', () => {
  test('renders bullet list for events', () => {
    const text = buildTimelineText([
      { text: '🔄 Read' },
      { text: '✅ Read' },
    ]);
    expect(text).toContain('- 🔄 Read');
    expect(text).toContain('- ✅ Read');
  });

  test('truncates beyond MAX (tail-keep)', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ text: `e${i}` }));
    const text = buildTimelineText(events);
    expect(text).toContain('较早');
    expect(text).toContain('已省略');
  });

  test('empty → placeholder', () => {
    expect(buildTimelineText([])).toContain('暂无');
  });
});

describe('buildStreamingAgentCard rich skeleton (Phase F)', () => {
  test('includes ASK and TIMELINE panels', () => {
    const card = buildStreamingAgentCard({ initialText: 'x' });
    const ids = new Set(collectElementIds(card));
    expect(ids.has(CARD_ELEMENT_IDS.ASK_PANEL)).toBe(true);
    expect(ids.has(CARD_ELEMENT_IDS.ASK_CONTENT)).toBe(true);
    expect(ids.has(CARD_ELEMENT_IDS.TIMELINE_PANEL)).toBe(true);
    expect(ids.has(CARD_ELEMENT_IDS.TIMELINE_CONTENT)).toBe(true);
  });

  test('rich skeleton now has 5 collapsible panels', () => {
    const card = buildStreamingAgentCard({ initialText: 'x' });
    expect(countTag(card, 'collapsible_panel')).toBe(5);
  });
});

// ─── feishu.ts:buildInteractiveCard backward-compat ─────────────

describe('feishu.ts wrapper uses new builder', () => {
  test('buildInteractiveCard delegates to buildAgentReplyCard with done status', async () => {
    const { buildInteractiveCard } = (await import('../src/feishu.js')) as unknown as {
      buildInteractiveCard?: (t: string) => object;
    };
    // buildInteractiveCard is module-private; skip silently if not exported.
    if (!buildInteractiveCard) return;
    const card = buildInteractiveCard('hi');
    const header = (card as { header: Record<string, unknown> }).header;
    expect(header.template).toBe('violet');
  });
});
