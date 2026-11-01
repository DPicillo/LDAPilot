import { createContext, memo, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent } from 'hast';
import { Check, Copy, ExternalLink, Table2 } from 'lucide-react';
import { isAnswerDN, isFilter, stripWordJoiner, toCSV, urlHost } from '../../lib/aiFormat';
import { copyText, openExternal } from '../../lib/ai';
import { DnLink } from './DnLink';
import { FilterLink } from './FilterLink';
import { iconButton, primaryButton, textButton } from './tone';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

/** Plain text of a hast node. */
export function hastText(node: Element | ElementContent | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map((c) => hastText(c)).join('');
  return '';
}

function hastRows(table: Element | undefined): string[][] {
  const rows: string[][] = [];
  const walk = (n: ElementContent) => {
    if (n.type !== 'element') return;
    if (n.tagName === 'tr') {
      rows.push(n.children.filter((c): c is Element => c.type === 'element' && (c.tagName === 'td' || c.tagName === 'th')).map((c) => stripWordJoiner(hastText(c)).trim()));
      return;
    }
    n.children.forEach(walk);
  };
  table?.children.forEach(walk);
  return rows;
}

function CopyButton({ text, label, what, icon }: { text: () => string; label: string; what: string; icon?: ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button"
      className={iconButton}
      title={label}
      aria-label={label}
      onClick={async () => {
        if (await copyText(text(), what)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? <Check size={12} /> : icon ?? <Copy size={12} />}
    </button>
  );
}

/**
 * Inside an answer table a DN shows only its RDN value (the full DN is in
 * the link's title, menu and the CSV/text copies): with full DNs, the DN
 * column alone filled the sidebar and hid every other column (the answer
 * itself: status, path, value).
 */
const TableCellContext = createContext(false);

/** A DN link; compact (RDN value only) inside a table cell. */
function AnswerDn({ dn }: { dn: string }) {
  const compact = useContext(TableCellContext);
  return <DnLink dn={dn} compact={compact} />;
}

/** Inline code: DNs and filters become links (U+2060 stripped). */
export function InlineCode({ text }: { text: string }) {
  if (isAnswerDN(text)) return <AnswerDn dn={text} />;
  if (isFilter(text)) return <FilterLink filter={text} />;
  return <code className="rounded bg-secondary px-1 font-mono text-xs">{text}</code>;
}

/** External link: http(s) only, opened in the system browser after confirming the host. */
function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  const ok = !!href && /^https?:\/\//i.test(href);
  if (!ok) return <span className="underline decoration-dotted">{children}</span>;
  const host = urlHost(href!);
  return (
    <span className="inline">
      <button type="button"
        className="inline cursor-pointer text-primary underline underline-offset-2"
        title={href}
        aria-label={`Open link to ${host}`}
        onClick={() => setConfirm((c) => !c)}
      >
        {children}
      </button>
      {confirm && (
        <span className="ml-1 inline-flex items-center gap-1 rounded border border-border bg-popover px-1 py-px text-xs">
          Open {host} in your browser?
          <Button size="sm" variant="primary" leftIcon={ExternalLink} aria-label={`Open ${host}`} onClick={() => { setConfirm(false); openExternal(href!); }}>Open</Button>
          <Button size="sm" variant="secondary" aria-label="Cancel" onClick={() => setConfirm(false)}>Cancel</Button>
        </span>
      )}
    </span>
  );
}

const components: Components = {
  p: ({ children }) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h3 className="mb-1 mt-2 text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1 mt-2 text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 mt-2 text-sm font-semibold">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 mt-2 text-sm font-semibold">{children}</h6>,
  // Models often write a DN in bold instead of inline code: a bold/italic run that is exactly a DN is a link too.
  strong: ({ node, children }) => {
    const t = hastText(node).trim();
    return node && node.children.every((c) => c.type === 'text') && isAnswerDN(t) ? <strong><AnswerDn dn={t} /></strong> : <strong className="font-semibold">{children}</strong>;
  },
  em: ({ node, children }) => {
    const t = hastText(node).trim();
    return node && node.children.every((c) => c.type === 'text') && isAnswerDN(t) ? <AnswerDn dn={t} /> : <em>{children}</em>;
  },
  blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 border-border pl-2 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-2 border-border" />,
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : '';
    const host = urlHost(url);
    const label = `image: ${alt || 'untitled'}${host ? ` (${host})` : ''}`;
    // Images are never loaded (§10.4).
    return /^https?:\/\//i.test(url) ? <SafeLink href={url}>{label}</SafeLink> : <span className="text-muted-foreground">[{label}]</span>;
  },
  pre: ({ node }) => {
    const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
    const text = hastText(code ?? node).replace(/\n$/, '');
    const cls = code?.properties?.className;
    const lang = Array.isArray(cls) ? String(cls.find((c) => String(c).startsWith('language-')) ?? '').replace('language-', '') : '';
    return (
      <div className="group relative my-1.5 rounded border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-2 py-0.5 text-xs text-muted-foreground">
          <span>{lang || 'code'}</span>
          <CopyButton text={() => text} label="Copy code" what="Code" />
        </div>
        <pre className="overflow-x-auto whitespace-pre p-2 font-mono text-xs leading-relaxed">{text}</pre>
      </div>
    );
  },
  code: ({ node }) => <InlineCode text={hastText(node)} />,
  table: ({ node, children }) => (
    <div className="group my-1.5 rounded border border-border">
      <div className="flex justify-end gap-0.5 border-b border-border px-1 py-0.5">
        <CopyButton text={() => toCSV(hastRows(node))} label="Copy table as CSV" what="Table" icon={<Table2 size={12} />} />
        <CopyButton text={() => hastRows(node).map((r) => r.join('\t')).join('\n')} label="Copy table as text" what="Table" />
      </div>
      <div className="max-w-full overflow-x-auto">
        {/* min-w-full: the table may grow wider than the panel and scroll; DNs in cells are compact (AnswerDn), so the other columns stay in view at the default width */}
        <table className="min-w-full border-collapse text-xs">{children}</table>
      </div>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-secondary">{children}</thead>,
  th: ({ children, style }) => <th style={style} className="border-b border-border px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ node, children, style }) => {
    const t = stripWordJoiner(hastText(node)).trim();
    const onlyText = !!node && node.children.every((c) => c.type === 'text');
    const dn = isAnswerDN(t);
    return (
      <td style={style} className="min-w-[4.5rem] border-b border-border px-2 py-1 align-top">
        <TableCellContext.Provider value={true}>{onlyText && dn ? <AnswerDn dn={t} /> : children}</TableCellContext.Provider>
      </td>
    );
  },
};

/** Markdown with GFM (tables, strikethrough, task lists); raw HTML is skipped. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('min-w-0 break-words text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
