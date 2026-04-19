'use client';

import { Fragment, type ReactNode } from 'react';
import { parseHypotheses, type HypothesisBlock } from '@/lib/projectBriefHypotheses/parseHypotheses';

interface LeadSourceHypothesesViewProps {
  markdown: string;
}

const URL_REGEX = /https?:\/\/[^\s)\]]+/g;

function prettifyUrl(url: string): string {
  return url
    .replace(/^https?:\/\/(www\.)?/i, '')
    .replace(/\/$/, '');
}

/** Inline-render value text with auto-linked URLs. */
function renderValue(text: string): ReactNode {
  if (!text) return null;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const start = match.index ?? 0;
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    parts.push(
      <a
        key={`u${key++}`}
        href={match[0]}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 hover:text-blue-800 underline decoration-blue-200 hover:decoration-blue-500 break-all"
      >
        {prettifyUrl(match[0])}
      </a>,
    );
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

function HypothesisCard({ block, index }: { block: HypothesisBlock; index: number }) {
  const number = block.number || String(index + 1);
  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <header className="mb-3 flex items-start gap-3">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
          {number}
        </div>
        <h4 className="pt-0.5 text-sm font-semibold leading-snug text-gray-900">
          {block.title}
        </h4>
      </header>

      {block.fields.length > 0 && (
        <dl className="space-y-2">
          {block.fields.map((field, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-[10rem_1fr]"
            >
              {field.label ? (
                <dt className="pt-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  {field.label}
                </dt>
              ) : (
                <dt className="hidden sm:block" />
              )}
              <dd className="text-sm leading-relaxed text-gray-700">
                {renderValue(field.value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

export function LeadSourceHypothesesView({ markdown }: LeadSourceHypothesesViewProps) {
  const blocks = parseHypotheses(markdown);

  if (blocks.length === 0) {
    return (
      <div className="text-sm leading-relaxed text-gray-600 whitespace-pre-wrap">
        {markdown}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, i) => (
        <HypothesisCard key={i} block={block} index={i} />
      ))}
    </div>
  );
}
