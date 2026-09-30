'use client';

import React from 'react';

/**
 * Minimal, dependency-free Markdown renderer for assistant messages.
 * Builds React elements only (never raw HTML), so model output is XSS-safe.
 * Supported: fenced code blocks (with language badge), headings, bullet and
 * numbered lists, blockquotes, horizontal rules, bold / italic / inline code /
 * strikethrough / links.
 */

/** Render inline markdown (code, bold, italic, links) as React nodes. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern =
    /(`[^`\n]+`)|(\*\*\*[^*\n]+\*\*\*)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|((?<![\w\\])_[^_\n]+_(?![\w]))|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^\s)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-i${i++}`;
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={k} className="rounded border border-zinc-800 bg-zinc-950/80 px-1 py-px text-[11px] text-emerald-300">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('***')) {
      nodes.push(
        <strong key={k} className="text-zinc-100">
          <em>{tok.slice(3, -3)}</em>
        </strong>,
      );
    } else if (tok.startsWith('**')) {
      nodes.push(
        <strong key={k} className="text-zinc-100">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith('~~')) {
      nodes.push(
        <del key={k} className="text-zinc-500">
          {tok.slice(2, -2)}
        </del>,
      );
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    } else {
      const label = tok.slice(1, tok.indexOf(']'));
      const href = tok.slice(tok.indexOf('(') + 1, -1);
      nodes.push(
        <a
          key={k}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 underline decoration-emerald-700 hover:text-emerald-300"
        >
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const LIST_BULLET = /^\s*[-*+]\s+/;
const LIST_NUMBER = /^\s*\d+[.)]\s+/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const FENCE = /^```(\w*)/;
const HR = /^\s*([-*_])\1{2,}\s*$/;

export default function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`space-y-1.5 ${className ?? ''}`}>{renderBlocks(text)}</div>;
}

/** A reply wrapped whole in a ```markdown fence — unwrap and render inside. */
const WRAPPER_FENCE = /^```(?:markdown|md)[ \t]*\r?\n([\s\S]*)```[ \t]*\r?\n?$/;

function renderBlocks(src: string, depth = 0): React.ReactNode[] {
  if (depth < 2) {
    const wrapped = WRAPPER_FENCE.exec(src.trim());
    if (wrapped) return renderBlocks(wrapped[1], depth + 1);
  }
  const out: React.ReactNode[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  const nextKey = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];
    const trimmedStart = line.trimStart();

    // Fenced code block
    const fence = FENCE.exec(trimmedStart);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or stop at EOF)
      if ((lang === 'markdown' || lang === 'md') && depth < 2) {
        // A ```markdown fence contains markdown, not code — render it.
        out.push(<div key={nextKey()}>{renderBlocks(body.join('\n'), depth + 1)}</div>);
        continue;
      }
      out.push(
        <div key={nextKey()} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/80">
          {lang ? <div className="px-2 pt-1 text-[9px] uppercase tracking-wide text-zinc-500">{lang}</div> : null}
          <pre className="ide-scrollbar overflow-x-auto px-2 py-1.5">
            <code className="whitespace-pre text-[11px] text-zinc-300">{body.join('\n')}</code>
          </pre>
        </div>,
      );
      continue;
    }

    // Heading
    const h = HEADING.exec(line);
    if (h) {
      const cls =
        h[1].length === 1
          ? 'text-sm font-semibold text-zinc-100'
          : h[1].length === 2
            ? 'text-[13px] font-semibold text-zinc-100'
            : 'text-xs font-semibold text-zinc-200';
      out.push(<div key={nextKey()} className={cls}>{renderInline(h[2], `h${i}`)}</div>);
      i++;
      continue;
    }

    // Horizontal rule
    if (HR.test(line)) {
      out.push(<hr key={nextKey()} className="border-zinc-800" />);
      i++;
      continue;
    }

    // Blockquote
    if (trimmedStart.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(
        <blockquote key={nextKey()} className="border-l-2 border-zinc-700 pl-2 text-zinc-400">
          {renderInline(body.join(' '), `q${i}`)}
        </blockquote>,
      );
      continue;
    }

    // Lists (bullet or numbered)
    if (LIST_BULLET.test(line) || LIST_NUMBER.test(line)) {
      const ordered = LIST_NUMBER.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? LIST_NUMBER.test(lines[i]) : LIST_BULLET.test(lines[i]))) {
        items.push(lines[i].replace(ordered ? LIST_NUMBER : LIST_BULLET, ''));
        i++;
      }
      const cls = `pl-4 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'} text-zinc-300`;
      out.push(
        <ol key={nextKey()} className={cls}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item, `l${i}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph — accumulate until a blank line or the next block construct.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith('```') &&
      !lines[i].trimStart().startsWith('>') &&
      !LIST_BULLET.test(lines[i]) &&
      !LIST_NUMBER.test(lines[i]) &&
      !HEADING.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={nextKey()} className="break-words whitespace-pre-wrap text-zinc-300">
        {renderInline(para.join('\n'), `p${i}`)}
      </p>,
    );
  }
  return out;
}
