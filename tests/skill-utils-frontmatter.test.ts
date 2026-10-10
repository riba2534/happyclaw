import { describe, expect, test } from 'vitest';
import { parseFrontmatter } from '../src/skill-utils.js';

function frontmatter(...lines: string[]): string {
  return ['---', ...lines, '---', '', '# Body'].join('\n');
}

describe('parseFrontmatter', () => {
  test('keeps plain values verbatim, including colons and hashes', () => {
    expect(
      parseFrontmatter(
        frontmatter(
          'name: api-harvester',
          'description: Use when: the user asks for a HAR #capture',
          'user-invocable: false',
          'allowed-tools: Read, Bash',
        ),
      ),
    ).toEqual({
      name: 'api-harvester',
      description: 'Use when: the user asks for a HAR #capture',
      'user-invocable': 'false',
      'allowed-tools': 'Read, Bash',
    });
  });

  test('strips quotes from double- and single-quoted scalars', () => {
    expect(
      parseFrontmatter(
        frontmatter(
          'name: "api-harvester"',
          "short: 'x'",
          'escaped: "say \\"hi\\"\\tthere"',
          "doubled: 'it''s fine'",
          'commented: "quoted" # trailing comment',
          'empty: ""',
        ),
      ),
    ).toEqual({
      name: 'api-harvester',
      short: 'x',
      escaped: 'say "hi"\tthere',
      doubled: "it's fine",
      commented: 'quoted',
      empty: '',
    });
  });

  test('keeps values that only start with a quote as plain text', () => {
    expect(
      parseFrontmatter(
        frontmatter('title: "Quoted" suffix', "open: 'unterminated"),
      ),
    ).toEqual({
      title: '"Quoted" suffix',
      open: "'unterminated",
    });
  });

  test('folds `>-` blocks into a single line', () => {
    expect(
      parseFrontmatter(
        frontmatter(
          'name: byte-pua',
          'description: >-',
          '  Review a change against six values,',
          '  then report findings.',
          'version: 1',
        ),
      ),
    ).toEqual({
      name: 'byte-pua',
      description: 'Review a change against six values, then report findings.',
      version: '1',
    });
  });

  test('folds `>` and `>+` blocks, keeping paragraph breaks', () => {
    const parsed = parseFrontmatter(
      frontmatter(
        'description: >',
        '  First paragraph',
        '  continues here.',
        '',
        '  Second paragraph.',
        '    indented detail',
        'other: >+',
        '  kept',
        '',
      ),
    );
    expect(parsed.description).toBe(
      'First paragraph continues here.\nSecond paragraph.\n  indented detail',
    );
    expect(parsed.other).toBe('kept');
  });

  test('keeps line breaks and relative indentation in literal blocks', () => {
    const parsed = parseFrontmatter(
      frontmatter(
        'description: |',
        '  Line one',
        '    nested: value',
        '',
        '  Line three',
        'strip: |- # comment',
        '  only line',
        'name: after',
      ),
    );
    expect(parsed.description).toBe('Line one\n  nested: value\n\nLine three');
    expect(parsed.strip).toBe('only line');
    expect(parsed.name).toBe('after');
  });

  test('honours an explicit indentation indicator', () => {
    expect(
      parseFrontmatter(
        frontmatter('description: |2', '    leading spaces', '  base'),
      ).description,
    ).toBe('  leading spaces\nbase');
  });

  test('treats an empty block scalar as an empty string', () => {
    expect(parseFrontmatter(frontmatter('description: >-', 'name: x'))).toEqual(
      { description: '', name: 'x' },
    );
  });

  test('accepts CRLF line endings', () => {
    const content = [
      '---',
      'name: "crlf-skill"',
      'description: >-',
      '  Folded across',
      '  Windows lines',
      '---',
      'Body',
    ].join('\r\n');
    expect(parseFrontmatter(content)).toEqual({
      name: 'crlf-skill',
      description: 'Folded across Windows lines',
    });
  });

  test('returns nothing without a closed frontmatter block', () => {
    expect(parseFrontmatter('name: x\n')).toEqual({});
    expect(parseFrontmatter('---\nname: x\n')).toEqual({});
  });
});
