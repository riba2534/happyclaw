import rehypeHighlight, { type Options } from 'rehype-highlight';

type HighlightTransformer = ReturnType<typeof rehypeHighlight>;

const transformers = new Map<string, HighlightTransformer>();

/** Mermaid sources render as diagrams; never spend highlighting on them. */
export const HIGHLIGHT_OPTIONS: Readonly<Options> = { plainText: ['mermaid'] };

/**
 * rehype-highlight creates a new lowlight (highlight.js) instance each time it
 * is attached, registering every grammar again and recompiling the ones a
 * code block uses, and react-markdown attaches its plugins on every render.
 * Reuse one transformer per option set so each grammar is registered and
 * compiled once per page: a streamed reply with code otherwise spent about a
 * fifth of its CPU time in highlight.js setup.
 *
 * Runs after rehype-sanitize: the `hljs-*` classes it adds are generated, not
 * user input, and must not need a sanitize exception.
 */
export function rehypeHighlightShared(
  options?: Readonly<Options>,
): HighlightTransformer {
  const key = JSON.stringify(options ?? {});
  let transformer = transformers.get(key);
  if (!transformer) {
    transformer = rehypeHighlight(options);
    transformers.set(key, transformer);
  }
  return transformer;
}
