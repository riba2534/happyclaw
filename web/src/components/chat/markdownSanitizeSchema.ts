import { defaultSchema, type Options } from 'rehype-sanitize';
import { MARKDOWN_HTML_TAG_NAMES } from '../../lib/markdown/html-tags';

/**
 * Sanitize schema for raw HTML in chat Markdown (AI replies, Skill READMEs).
 *
 * Sanitizing runs before rehype-highlight and rehype-katex, so neither needs
 * an exception here: their classes, inline styles and SVG are generated
 * afterwards from trusted code. User HTML gets no `class` or `style` on any
 * element, which used to let a reply lay a transparent `position:fixed`
 * layer over the conversation, also through the app's own positioning
 * utility classes.
 *
 * `code` keeps only the classes the Markdown pipeline itself relies on:
 * `language-*` for highlighting and Mermaid, `math-inline`/`math-display`
 * for remark-math output that KaTeX renders after sanitizing.
 */
export const markdownSanitizeSchema: Options = {
  ...defaultSchema,
  tagNames: [...MARKDOWN_HTML_TAG_NAMES],
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Inline images; the URL transform narrows this to `data:image/*`.
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
};
