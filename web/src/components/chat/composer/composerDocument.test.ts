// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TextSelection } from '@tiptap/pm/state';

import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList,
} from './cindy/ComposerListNodes';
import { serializeEditorContent } from './cindy/composerContentSerialization';
import { MentionChipNode } from './cindy/MentionChipNode';
import { plainTextToComposerDocument } from './cindy/composerListDocument';
import {
  appendComposerText,
  composerDocFor,
  findFilledBlocks,
  isComposerDocJSON,
  readComposerTrigger,
} from './composerDocument';
import { sentMessageHistory } from './sentHistory';
import { splitWorkspaceQuery } from './paletteSources';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function create(text: string): Editor {
  editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      ComposerListItem,
      ComposerBulletList,
      ComposerOrderedList,
      MentionChipNode,
    ],
    content: plainTextToComposerDocument(text),
  });
  return editor;
}

/** Put the caret at the end of the `index`-th text block. */
function caretAtEndOfBlock(ed: Editor, index: number) {
  let seen = -1;
  let pos = 0;
  ed.state.doc.descendants((node, nodePos) => {
    if (node.isTextblock && ++seen === index) pos = nodePos + node.nodeSize - 1;
    return true;
  });
  ed.view.dispatch(
    ed.state.tr.setSelection(TextSelection.create(ed.state.doc, pos)),
  );
}

describe('readComposerTrigger', () => {
  it('opens / only at the start of the message', () => {
    const ed = create('/rev');
    caretAtEndOfBlock(ed, 0);
    expect(readComposerTrigger(ed.state)).toEqual({
      kind: 'slash',
      query: 'rev',
      from: 1,
    });

    const later = create('先说明\n/rev');
    caretAtEndOfBlock(later, 1);
    expect(readComposerTrigger(later.state)).toEqual({ kind: 'none' });
  });

  it('opens @ after whitespace on any line, mapped to document positions', () => {
    const ed = create('第一行\n看看 @no');
    caretAtEndOfBlock(ed, 1);
    const trigger = readComposerTrigger(ed.state);
    expect(trigger).toMatchObject({ kind: 'at', query: 'no' });
    if (trigger.kind !== 'at') throw new Error('expected @');
    expect(ed.state.doc.textBetween(trigger.from, trigger.from + 3)).toBe(
      '@no',
    );
  });

  it('counts a hard break as the start of a new line', () => {
    const ed = create('');
    ed.commands.insertContent([
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: '@x' },
    ]);
    expect(readComposerTrigger(ed.state)).toMatchObject({
      kind: 'at',
      query: 'x',
    });
  });

  it('closes once the run contains whitespace', () => {
    const ed = create('@notes now');
    caretAtEndOfBlock(ed, 0);
    expect(readComposerTrigger(ed.state)).toEqual({ kind: 'none' });
  });
});

describe('appendComposerText', () => {
  it('adds a new line, or a blank line between, after existing text', () => {
    const ed = create('已有');
    appendComposerText(ed, '追加', { gap: 0, focus: false });
    expect(serializeEditorContent(ed).text).toBe('已有\n追加');
    appendComposerText(ed, '恢复的修改', { gap: 1, focus: false });
    expect(serializeEditorContent(ed).text).toBe('已有\n追加\n\n恢复的修改');
  });

  it('fills an empty composer', () => {
    const ed = create('');
    appendComposerText(ed, '- 一\n- 二', { gap: 1, focus: false });
    expect(ed.state.doc.firstChild?.type.name).toBe('bulletList');
    expect(serializeEditorContent(ed).text).toBe('- 一\n- 二');
  });
});

describe('findFilledBlocks', () => {
  it('finds the last unchanged run of the blocks a text makes', () => {
    const ed = create('甲\n问\n答：乙\n问\n答：乙');
    const { doc } = ed.state;
    const range = findFilledBlocks(doc, '问\n答：乙');
    expect(range).toEqual({
      from:
        doc.child(0).nodeSize + doc.child(1).nodeSize + doc.child(2).nodeSize,
      to: doc.content.size,
    });
    expect(findFilledBlocks(doc, '答')).toBeNull();
    expect(findFilledBlocks(doc, '')).toBeNull();
  });
});

describe('composerDocFor', () => {
  it('keeps a loadable stored document and rebuilds a foreign one', () => {
    const stored = plainTextToComposerDocument('a');
    expect(composerDocFor('ignored', stored)).toBe(stored);
    expect(
      composerDocFor('b', {
        type: 'doc',
        content: [{ type: 'composerQuote' }],
      }),
    ).toEqual(plainTextToComposerDocument('b'));
    expect(composerDocFor('c', null)).toEqual(plainTextToComposerDocument('c'));
  });
});

describe('isComposerDocJSON', () => {
  it('accepts composer documents and rejects foreign nodes or marks', () => {
    expect(isComposerDocJSON(plainTextToComposerDocument('a\n- b'))).toBe(true);
    expect(
      isComposerDocJSON({
        type: 'doc',
        content: [{ type: 'composerQuote' }],
      }),
    ).toBe(false);
    expect(
      isComposerDocJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('sentMessageHistory', () => {
  const message = (content: string, extra: Record<string, unknown> = {}) =>
    ({
      id: content,
      chat_jid: 'web:g1',
      sender: 'u1',
      sender_name: 'U',
      content,
      timestamp: '2026-01-01T00:00:00.000Z',
      is_from_me: false,
      ...extra,
    }) as never;

  it("lists this user's messages newest first, repeats once", () => {
    const state = {
      agentMessages: {
        a1: [
          message('一'),
          message('二'),
          message('二'),
          message('回复', { is_from_me: true }),
          message('群友', { sender: 'u2' }),
          message('context_reset', { sender: '__system__' }),
          message('  '),
        ],
        a2: [message('会话')],
      },
    };
    expect(sentMessageHistory(state, 'web:g1#agent:a1', 'u1')).toEqual([
      '二',
      '一',
    ]);
    expect(sentMessageHistory(state, 'web:g1#agent:a2', 'u1')).toEqual([
      '会话',
    ]);
    // A workspace key names no conversation.
    expect(sentMessageHistory(state, 'web:g1', 'u1')).toEqual([]);
  });

  it('recalls the text of a message, not the uploaded-file announcement', () => {
    const state = {
      agentMessages: {
        a1: [
          message(
            '[我上传了以下文件到工作区，请查看并使用]\n- a.pdf\n\n总结一下',
          ),
          message('[我上传了以下文件到工作区，请查看并使用]\n- b.pdf'),
        ],
      },
    };
    expect(sentMessageHistory(state, 'web:g1#agent:a1', 'u1')).toEqual([
      '总结一下',
    ]);
  });
});

describe('splitWorkspaceQuery', () => {
  it('lists the typed directory and filters by the rest', () => {
    expect(splitWorkspaceQuery('')).toEqual({ dir: '', needle: '' });
    expect(splitWorkspaceQuery('read')).toEqual({ dir: '', needle: 'read' });
    expect(splitWorkspaceQuery('src/comp')).toEqual({
      dir: 'src',
      needle: 'comp',
    });
    expect(splitWorkspaceQuery('/src/a/')).toEqual({
      dir: 'src/a',
      needle: '',
    });
  });

  it('never lists outside the workspace', () => {
    expect(splitWorkspaceQuery('../etc/pa')).toEqual({ dir: '', needle: 'pa' });
  });
});
