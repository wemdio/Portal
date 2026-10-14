'use client';

/**
 * Отчёт блокировки / разблокировки клиента английского кабинета: заголовок и
 * строки шагов (их тексты пишет engAccountBlock на сервере — здесь только
 * цвет): зелёная — шаг сделан, красная — не остановилось, серая — пояснение.
 * `history` — отчёт снятой блокировки: серая рамка и серый заголовок.
 */

import type { HeEngBlockLine } from '@/lib/hypothesisEngine/engAccountBlockMarker';

export function EngBlockReport({
  title,
  headline,
  complete,
  lines,
  history = false,
}: {
  title?: string;
  /** Одна фраза итога; null — без заголовка. */
  headline: string | null;
  complete: boolean;
  lines: readonly HeEngBlockLine[];
  history?: boolean;
}) {
  const frame = history ? 'border-gray-200 bg-gray-50' : complete ? 'border-green-200 bg-green-50/60' : 'border-red-200 bg-red-50/60';
  const headlineTone = history ? 'text-gray-700' : complete ? 'text-green-800' : 'text-red-800';
  return (
    <div className={`rounded-xl border p-4 ${frame}`} role="status">
      {title ? <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p> : null}
      {headline ? <p className={`text-sm font-semibold ${headlineTone}`}>{headline}</p> : null}
      {lines.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {lines.map((line, i) => (
            <li
              key={i}
              data-tone={line.tone}
              className={`flex gap-2 text-sm leading-snug ${
                line.tone === 'ok' ? 'text-green-800' : line.tone === 'red' ? 'text-red-700' : 'text-gray-600'
              }`}
            >
              <span aria-hidden className="mt-0.5 shrink-0">
                {line.tone === 'ok' ? '✓' : line.tone === 'red' ? '✕' : '·'}
              </span>
              <span className="min-w-0 break-words">{line.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
