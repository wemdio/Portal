'use client';

/**
 * Просмотр финального шаблона 85/15: фиксированный блок, финальные письма
 * с подсвеченными {{operators}}, маппинг операторов на колонки базы и
 * экспорт (копирование / скачивание JSON).
 */

import { useCallback, useState } from 'react';
import { Check, Copy, Download, FileText } from 'lucide-react';
import type { HeTemplate } from '@/lib/hypothesisEngine/types';
import { Badge, OperatorText } from './ui';

function templateToText(t: HeTemplate): string {
  const parts: string[] = [`ФИКСИРОВАННЫЙ БЛОК (85%):\n${t.fixed_block}`];
  t.letters.forEach((letter, idx) => {
    const wait = letter.wait_days > 0 ? ` (пауза ${letter.wait_days} дн.)` : '';
    parts.push(
      `\n--- ПИСЬМО ${idx + 1}${wait} ---\nТема: ${letter.subject ?? ''}\n\n${letter.body}`,
    );
    (letter.segment_variants ?? []).forEach((v) => {
      parts.push(`\n[Вариант для сегмента: ${v.when}]\n${v.text}`);
    });
  });
  return parts.join('\n');
}

export function TemplateView({ template }: { template: HeTemplate }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(templateToText(template)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [template]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `he-template-${template.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [template]);

  const mapping = template.personalization_plan?.operator_mapping ?? [];

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-gray-50/50 p-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-gray-400" aria-hidden />
            <p className="text-sm font-semibold text-gray-800">Шаблон 85/15</p>
            {template.status === 'ready' ? <Badge tone="emerald">Готов</Badge> : <Badge tone="amber">Черновик</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Скачать JSON
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Боевой шаблон: цепочка вертикали, адаптированная под загруженную базу. В рассылку идёт этот
          текст.
        </p>
      </div>

      {/* Фиксированный блок */}
      <section>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
          Фиксированный блок (85%)
        </p>
        <div className="rounded-lg border-2 border-dashed border-blue-200 bg-blue-50/40 p-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{template.fixed_block}</p>
        </div>
      </section>

      {/* Финальные письма */}
      <section>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
          Финальные письма ({template.letters.length})
        </p>
        <ol className="space-y-3">
          {template.letters.map((letter, idx) => (
            <li key={idx} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700">
                  {idx + 1}
                </span>
                {letter.subject ? (
                  <OperatorText text={letter.subject} className="text-sm font-semibold text-gray-900" />
                ) : (
                  <p className="text-sm italic text-gray-400">Без темы</p>
                )}
                {letter.wait_days > 0 ? (
                  <span className="text-[11px] text-gray-400">пауза {letter.wait_days} дн.</span>
                ) : null}
              </div>
              <OperatorText
                text={letter.body}
                className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700"
              />
              {letter.segment_variants?.length ? (
                <div className="mt-3 space-y-2">
                  {letter.segment_variants.map((v, vi) => (
                    <details
                      key={`${v.when}-${vi}`}
                      className="rounded-lg border border-violet-200 bg-violet-50/40"
                    >
                      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-violet-700">
                        Вариант для сегмента: {v.when}
                      </summary>
                      <div className="border-t border-violet-100 px-3 py-2">
                        <OperatorText
                          text={v.text}
                          className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700"
                        />
                      </div>
                    </details>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {/* Маппинг операторов */}
      {mapping.length > 0 ? (
        <section>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
            Маппинг операторов на колонки базы
          </p>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Оператор
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Колонка базы
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Статус
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {mapping.map((m, i) => (
                  <tr key={`${m.operator}-${i}`}>
                    <td className="px-3 py-2">
                      <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs text-amber-800">
                        {`{{${m.operator}}}`}
                      </code>
                    </td>
                    <td className="px-3 py-2 text-gray-700">{m.column ?? '—'}</td>
                    <td className="px-3 py-2">
                      {m.matched ? (
                        <Badge tone="emerald">Совпало</Badge>
                      ) : (
                        <Badge tone="red">Нет колонки</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
