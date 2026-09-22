'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { parseDigest, type DigestSection } from '@/lib/changelog/digest';

/**
 * Тело сводки обновлений: разделы и пункты.
 *
 * Общее для окна при входе и для карточки уведомления — сводка одна и та же,
 * и две её вёрстки разъехались бы на первой правке.
 */

/** Технический раздел свёрнут: он есть, но сводку собой не заслоняет. */
function Section({ section }: { section: DigestSection }) {
  const [open, setOpen] = useState(section.kind !== 'technical');

  return (
    <section className="border-t border-gray-100 pt-3 first:border-t-0 first:pt-0">
      {section.title ? (
        section.kind === 'technical' ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-400 transition hover:text-gray-600"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
            {section.title}
            <span className="font-normal normal-case text-gray-300">({section.items.length})</span>
          </button>
        ) : (
          <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-500">{section.title}</h3>
        )
      ) : null}

      {open ? (
        <ol className="mt-2 space-y-2">
          {section.items.map((item, index) => (
            <li key={index} className="flex gap-2 text-sm leading-relaxed text-gray-700">
              <span className="mt-0.5 shrink-0 text-xs tabular-nums text-gray-300">{index + 1}</span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function DigestBody({ summary }: { summary: string }) {
  const sections = parseDigest(summary);
  if (!sections.length) {
    return <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700">{summary}</p>;
  }
  return (
    <div className="space-y-4">
      {sections.map((section, index) => (
        <Section key={`${section.title}-${index}`} section={section} />
      ))}
    </div>
  );
}
