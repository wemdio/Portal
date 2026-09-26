'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { parseDigest, type DigestSection } from '@/lib/changelog/digest';

/**
 * Тело сводки обновлений: разделы и пункты.
 *
 * Общее для окна при входе и для карточки уведомления — сводка одна и та же,
 * и две её вёрстки разъехались бы на первой правке.
 */

/**
 * Жирный текст из разметки: «**TG Outreach:**» → <strong>TG Outreach:</strong>.
 *
 * Сводку пишет ИИ, и звёздочки в ней есть всегда — это его способ выделить
 * инструмент в начале пункта. В телеграме их разбирает сам мессенджер, а здесь
 * они оставались видимым мусором посреди предложения.
 *
 * Разбираем только жирный: остальной разметки в сводке не бывает, а тащить
 * сюда полноценный markdown ради одной конструкции — менять понятные пять
 * строк на зависимость.
 */
function renderInline(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, index) =>
    // Нечётные куски — то, что стояло между звёздочками.
    index % 2 === 1 ? <strong key={index}>{part}</strong> : <Fragment key={index}>{part}</Fragment>,
  );
}

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
            className="flex w-full items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 transition hover:text-gray-900"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
            {renderInline(section.title)}
            <span className="font-normal normal-case text-gray-400">({section.items.length})</span>
          </button>
        ) : (
          <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-500">
            {renderInline(section.title)}
          </h3>
        )
      ) : null}

      {open ? (
        <ol className="mt-2 space-y-2">
          {section.items.map((item, index) => (
            // Цвет тот же, что у заголовка окна (text-gray-900): тёмная тема
            // перекрашивает именно его, а на приглушённом text-gray-700 текст
            // оставался почти нечитаемым.
            <li key={index} className="flex gap-2 text-sm leading-relaxed text-gray-900">
              <span className="mt-0.5 shrink-0 text-xs tabular-nums text-gray-400">{index + 1}</span>
              <div className="min-w-0">
                <span>{renderInline(item.text)}</span>
                {item.children.length ? (
                  <ul className="mt-1 space-y-1">
                    {item.children.map((child, childIndex) => (
                      <li key={childIndex} className="flex gap-2">
                        <span className="shrink-0 text-gray-400">•</span>
                        <span>{renderInline(child)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
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
    return <p className="whitespace-pre-line text-sm leading-relaxed text-gray-900">{renderInline(summary)}</p>;
  }
  return (
    <div className="space-y-4">
      {sections.map((section, index) => (
        <Section key={`${section.title}-${index}`} section={section} />
      ))}
    </div>
  );
}
