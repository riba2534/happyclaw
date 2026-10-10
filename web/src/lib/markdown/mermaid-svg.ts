import type { MouseEvent } from 'react';
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';

const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const SAFE_LINK = /^(?:https?:|mailto:)/i;

let purifier: Purifier | null = null;

function linkHref(link: Element): string | null {
  return (
    link.getAttribute('href') ?? link.getAttributeNS(XLINK_NAMESPACE, 'href')
  );
}

function isSafeLink(href: string | null): href is string {
  return href !== null && SAFE_LINK.test(href.trim());
}

/**
 * A private DOMPurify instance: hooks registered on the shared default one
 * would apply to every other caller in the app.
 */
function mermaidPurifier(): Purifier {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  // `click A href "…"` becomes an SVG link. Opened in place it navigated the
  // whole app away (losing drafts); keep only web links, in a new tab.
  instance.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName.toLowerCase() !== 'a') return;
    if (!isSafeLink(linkHref(node))) {
      node.removeAttribute('href');
      node.removeAttributeNS(XLINK_NAMESPACE, 'href');
      node.removeAttribute('target');
      return;
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  purifier = instance;
  return instance;
}

/** Sanitize the SVG Mermaid rendered before it is inserted as HTML. */
export function sanitizeMermaidSvg(raw: string): string {
  return mermaidPurifier().sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
  });
}

/**
 * Click handler for a container of sanitized diagram SVG: a click on a
 * diagram link opens it in a new tab without an opener (SVG links do not
 * reliably honour `rel`) instead of navigating the app. Returns whether the
 * click was on a link.
 */
export function openMermaidLink(event: MouseEvent<HTMLElement>): boolean {
  const link = (event.target as Element | null)?.closest?.('a');
  if (!link || !event.currentTarget.contains(link)) return false;
  event.preventDefault();
  event.stopPropagation();
  const href = linkHref(link);
  if (isSafeLink(href)) window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}
