import { toBase64Url } from '../stores/files';
import { withBasePath } from './url';

const ENCODED_BYTE_RUN = /(?:%[0-9a-f]{2})+/gi;
// decodeURI preserves most URI-reserved escapes, but not these seven.
const DECODE_URI_UNESCAPED_RESERVED = /(%(?:21|27|28|29|2a|5b|5d))/gi;
const DECODE_URI_UNESCAPED_RESERVED_EXACT = /^%(?:21|27|28|29|2a|5b|5d)$/i;

function decodeValidPrefixes(value: string): string {
  let decoded = '';
  let remaining = value;

  while (remaining) {
    let decodedLength = 0;
    for (let length = remaining.length; length > 0; length -= 3) {
      try {
        decoded += decodeURI(remaining.slice(0, length));
        decodedLength = length;
        break;
      } catch {
        // Try a shorter prefix so one malformed UTF-8 byte stays literal while
        // later valid UTF-8 in the same run can still be decoded.
      }
    }

    if (decodedLength === 0) {
      decoded += remaining.slice(0, 3);
      decodedLength = 3;
    }
    remaining = remaining.slice(decodedLength);
  }

  return decoded;
}

/**
 * Decode the percent-encoded UTF-8 produced by micromark without changing URI
 * reserved escapes or letting one malformed escape prevent later text from
 * being decoded.
 */
export function decodeMarkdownImagePath(value: string): string {
  return value.replace(ENCODED_BYTE_RUN, (run) =>
    run
      .split(DECODE_URI_UNESCAPED_RESERVED)
      .map((part) =>
        DECODE_URI_UNESCAPED_RESERVED_EXACT.test(part)
          ? part
          : decodeValidPrefixes(part),
      )
      .join(''),
  );
}

/** Absolute URLs, protocol-relative and root-relative paths are not files. */
const NON_WORKSPACE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i;

function workspaceFileUrl(
  kind: 'download' | 'preview',
  path: string,
  groupJid: string,
): string {
  const baseJid = groupJid.replace(/#agent:.*$/, '');
  const encoded = toBase64Url(decodeMarkdownImagePath(path));
  return withBasePath(
    `/api/groups/${encodeURIComponent(baseJid)}/files/${kind}/${encoded}`,
  );
}

/** Resolve a markdown image source to the local file download API. */
export function resolveMarkdownImageSrc(
  src: string,
  groupJid?: string,
): string {
  if (!groupJid || !src) return src;
  if (NON_WORKSPACE_URL.test(src)) return src;
  return workspaceFileUrl('download', src, groupJid);
}

/**
 * Resolve a relative markdown link (`[报告](output/report.md)`) to the
 * workspace file preview API, which serves safe types inline and downloads
 * the rest. Left as is: in-page anchors, URLs with a scheme, protocol- and
 * root-relative paths, and any link without a workspace.
 */
export function resolveMarkdownLinkHref(
  href: string,
  groupJid?: string,
): string {
  if (!groupJid || !href || href.startsWith('#')) return href;
  if (NON_WORKSPACE_URL.test(href)) return href;
  const path = href.replace(/[?#].*$/, '');
  if (!path) return href;
  return workspaceFileUrl('preview', path, groupJid);
}
