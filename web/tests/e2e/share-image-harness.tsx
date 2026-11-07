// The share-image dialog over one reply (no backend):
//   ?reply=short   fits the phone card
//          medium  fits the phone card, too tall to export it at 2x
//          long    cut on the phone card, whole on the 720 card
//          huge    cut on the 720 card too, in under 30,000 characters
import { createRoot } from 'react-dom/client';
import { ShareImageDialog } from '../../src/components/chat/ShareImageDialog';
import type { Message } from '../../src/stores/chat';
import '@fontsource-variable/inter';
import '../../src/styles/globals.css';

const SENTENCE =
  'The share card wraps this reply at its own width, so a narrow card runs taller than a wide one.';

/** Paragraphs that start at the left edge and fill whole lines. */
function paragraphs(count: number, sentences: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `Paragraph ${i + 1}. ${Array(sentences).fill(SENTENCE).join(' ')}`,
  ).join('\n\n');
}

const replies: Record<string, string> = {
  short: paragraphs(4, 3),
  medium: paragraphs(60, 3),
  long: paragraphs(160, 3),
  // One line each: tall for its length.
  huge: paragraphs(800, 0),
};

const reply = new URLSearchParams(window.location.search).get('reply');
const content = replies[reply ?? 'short'] ?? replies.short;
document.documentElement.dataset.replyLength = String(content.length);

const message: Message = {
  id: 'share-reply',
  chat_jid: 'web:share-harness',
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content,
  timestamp: '2026-11-07T08:00:00.000Z',
  is_from_me: false,
};

createRoot(document.getElementById('root')!).render(
  <ShareImageDialog onClose={() => undefined} message={message} />,
);
