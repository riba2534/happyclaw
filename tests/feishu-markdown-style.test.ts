import { describe, expect, test } from 'vitest';
import { optimizeMarkdownStyle } from '../src/feishu-markdown-style.js';

describe('optimizeMarkdownStyle 代码块保护', () => {
  test("代码块中的 $& / $' / $` / $1 不被 GetSubstitution 损坏", () => {
    // shell / regex / perl 代码块中这些模式极常见。
    // 历史 bug: String.replace(str, block) 的字符串替换形式会把 $& 展开为
    // 匹配文本($& → ___CB_0___)、$' 展开为后文,导致内容重复/损坏。
    const code = [
      '```bash',
      'echo "$& $\' $` $1 $$PID"',
      "sed 's/foo/$&-bar/'",
      '```',
    ].join('\n');
    const input = `前文\n\n${code}\n\n后文`;
    const out = optimizeMarkdownStyle(input, 2);
    expect(out).toContain('echo "$& $\' $` $1 $$PID"');
    expect(out).toContain("sed 's/foo/$&-bar/'");
    // 占位符不应泄漏到输出
    expect(out).not.toContain('___CB_');
  });

  test('多个代码块均正确还原', () => {
    const input = '```js\nconst a = "$1";\n```\n\n中间\n\n```py\nx = "$&"\n```';
    const out = optimizeMarkdownStyle(input, 1);
    expect(out).toContain('const a = "$1";');
    expect(out).toContain('x = "$&"');
    expect(out).not.toContain('___CB_');
  });

  test.each([1, 2])('版本 %s 保留围栏内空行和图片语法字面量', (version) => {
    const code =
      '```markdown\n# Literal heading\n\n\n\n![demo](https://example.com/image.png)\n![local](./image.png)\n```';
    const input =
      '# Real heading\n\n\n' +
      code +
      '\n\n![outside](https://example.com/remove.png)';
    const out = optimizeMarkdownStyle(input, version);
    expect(out).toContain(code);
    expect(out).toContain('#### Real heading');
    expect(out).not.toContain('![outside]');
  });

  test.each(['~~~python', '````markdown'])(
    '支持 %s 围栏且不会被内部较短围栏提前关闭',
    (opener) => {
      const closer = opener.startsWith('~') ? '~~~' : '````';
      const code = [
        opener,
        '```',
        '# Literal',
        '',
        '',
        '![img](./source.png)',
        closer,
      ].join('\n');
      expect(optimizeMarkdownStyle(code, 2)).toContain(code);
    },
  );

  test('未闭合流式尾部保留原文，末尾不注入 br 字面量', () => {
    const code =
      '~~~markdown\n# Literal\n\n\n![img](https://example.com/source.png)';
    const out = optimizeMarkdownStyle(code, 2);
    expect(out.endsWith(code)).toBe(true);
    expect(out.slice(out.indexOf('~~~'))).toBe(code);
  });

  test('围栏中的标题不会触发围栏外 H4 的降级', () => {
    const input = '#### Keep this size\n\n```md\n# Literal\n```';
    expect(optimizeMarkdownStyle(input)).toContain('#### Keep this size');
    expect(optimizeMarkdownStyle(input)).not.toContain('##### Keep this size');
  });

  test('保护占位符不会覆盖用户原文', () => {
    const input =
      '\uE000HC_CODE_0\uE001\n\n___CB_0___\n\n```ts\nconst x = 1;\n```';
    const out = optimizeMarkdownStyle(input);
    expect(out).toContain('\uE000HC_CODE_0\uE001');
    expect(out).toContain('___CB_0___');
    expect(out).toContain('```ts\nconst x = 1;\n```');
  });

  test('正常正文继续优化标题、表格间距、图片和冗余空行', () => {
    const input =
      '# Heading\n\n\n\nIntro\n| A | B |\n| --- | --- |\n| a | b |\n\n![ok](img_real)\n![bad](./file.png)';
    const out = optimizeMarkdownStyle(input);
    expect(out).toContain('#### Heading');
    expect(out).toContain('<br>');
    expect(out).toContain('| a | b |');
    expect(out).toContain('![ok](img_real)');
    expect(out).not.toContain('![bad]');
    expect(out).not.toContain('\n\n\n');
  });
});
