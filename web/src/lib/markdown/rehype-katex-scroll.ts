import type { Element, Root, RootContent } from 'hast';

function walk(nodes: RootContent[]) {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    const className = (node as Element).properties.className;
    if (Array.isArray(className) && className.includes('katex-display')) {
      // Display math scrolls sideways (globals.css); a horizontal swipe on it
      // must not trigger the mobile swipe-back gesture.
      node.properties.dataSwipeBackIgnore = 'true';
      continue;
    }
    walk(node.children);
  }
}

/** Mark KaTeX display blocks as horizontal scrollers. Run after rehype-katex. */
export function rehypeKatexScroll() {
  return (tree: Root) => walk(tree.children);
}
