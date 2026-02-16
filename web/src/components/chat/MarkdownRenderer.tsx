import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { useState, memo } from 'react';
import { Copy, Check } from 'lucide-react';
import { toBase64Url } from '../../stores/files';
import { withBasePath } from '../../utils/url';
import 'highlight.js/styles/github.css';

interface MarkdownRendererProps {
  content: string;
  groupJid?: string;
}

/** Resolve relative image paths to the file download API */
function resolveImageSrc(src: string, groupJid?: string): string {
  if (!groupJid || !src) return src;
  if (/^(https?:\/\/|data:|\/\/)/.test(src) || src.startsWith('/')) return src;
  const encoded = toBase64Url(src);
  return withBasePath(`/api/groups/${encodeURIComponent(groupJid)}/files/download/${encoded}`);
}

/** Image lightbox for markdown images */
function MarkdownImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <img
        src={src}
        alt="放大查看"
        className="max-w-full max-h-full object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/** Inline image component with lightbox support */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);

  if (!src) return null;

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 bg-slate-100 text-slate-500 rounded text-sm">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
        </svg>
        {alt || '图片加载失败'}
      </span>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className="my-3 max-w-full rounded-lg border border-slate-200 cursor-pointer hover:shadow-md transition-shadow"
        style={{ maxHeight: '400px', objectFit: 'contain' }}
        onClick={() => setExpanded(true)}
        onError={() => setError(true)}
      />
      {expanded && <MarkdownImageLightbox src={src} onClose={() => setExpanded(false)} />}
    </>
  );
}

/** Allow class names on code/span elements so rehype-highlight styles survive sanitization */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'className'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), 'data'],
  },
};

/** Code block / inline code renderer extracted from MarkdownRenderer */
function CodeBlock({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const isBlock = Boolean(match);
  const codeString = String(children).replace(/\n$/, '');

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isBlock) {
    return (
      <div className="relative group my-4 overflow-hidden">
        <div className="absolute right-2 top-2 opacity-70 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs flex items-center gap-1"
          >
            {copied ? (
              <>
                <Check size={14} />
                已复制
              </>
            ) : (
              <>
                <Copy size={14} />
                复制
              </>
            )}
          </button>
        </div>
        <pre className="!bg-[#f6f8fa] rounded-lg p-4 overflow-x-auto">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      </div>
    );
  }

  return (
    <code
      className="bg-brand-50 text-primary px-1.5 py-0.5 rounded text-sm font-mono break-all"
      {...props}
    >
      {children}
    </code>
  );
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, groupJid }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
      components={{
        code: CodeBlock,
        img: ({ src, alt }) => <MarkdownImage src={src ? resolveImageSrc(src, groupJid) : undefined} alt={alt} />,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary underline break-all"
          >
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-4">
            <table className="min-w-full border-collapse border border-slate-200">
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-slate-50">{children}</thead>
        ),
        tbody: ({ children }) => <tbody className="divide-y divide-slate-200">{children}</tbody>,
        tr: ({ children }) => (
          <tr className="even:bg-white odd:bg-slate-50">
            {children}
          </tr>
        ),
        th: ({ children }) => (
          <th className="px-4 py-2 text-left text-sm font-semibold text-slate-900 border border-slate-200">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-4 py-2 text-sm text-slate-700 border border-slate-200">
            {children}
          </td>
        ),
        ul: ({ children }) => (
          <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>
        ),
        p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
        h1: ({ children }) => (
          <h1 className="text-2xl font-bold mt-6 mb-4">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-xl font-bold mt-5 mb-3">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-lg font-semibold mt-4 mb-2">{children}</h3>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-slate-300 pl-4 my-4 text-slate-600 italic">
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
});
