'use client';

/**
 * Просмотр вокабуляра вертикали: матрица типов компаний, матрица должностей
 * и готовые поисковые запросы, сгруппированные по источнику.
 */

import { useMemo } from 'react';
import { BookOpen, Search } from 'lucide-react';
import type { HeCompanyTypeKind, HeVocab } from '@/lib/hypothesisEngine/types';
import { Badge, type BadgeTone } from './ui';

const KIND_META: Record<HeCompanyTypeKind, { label: string; tone: BadgeTone }> = {
  canonical: { label: 'Каноническое', tone: 'emerald' },
  synonym: { label: 'Синоним', tone: 'blue' },
  geo_variant: { label: 'Гео-вариант', tone: 'amber' },
  adjacent: { label: 'Смежное', tone: 'violet' },
  slang: { label: 'Сленг', tone: 'gray' },
};

const TH_CLASS = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500';
const TD_CLASS = 'px-3 py-2 align-top text-gray-700';

export function VocabView({ vocab }: { vocab: HeVocab }) {
  const queriesBySource = useMemo(() => {
    const map = new Map<string, typeof vocab.search_queries>();
    for (const q of vocab.search_queries) {
      const key = q.source || 'Прочее';
      const list = map.get(key) ?? [];
      list.push(q);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [vocab.search_queries]);

  return (
    <div className="space-y-5 rounded-xl border border-gray-200 bg-gray-50/50 p-4">
      <div>
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-gray-400" aria-hidden />
          <p className="text-sm font-semibold text-gray-800">Вокабуляр вертикали</p>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Технический слой для сбора базы: по этим терминам ищем компании и должности в
          HH/LinkedIn/картах/реестрах. В текстах писем не используется.
        </p>
      </div>

      {/* Типы компаний */}
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
          Типы компаний ({vocab.company_types.length})
        </p>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className={TH_CLASS}>Термин</th>
                <th className={TH_CLASS}>Вид</th>
                <th className={TH_CLASS}>Гео</th>
                <th className={TH_CLASS}>Заметки</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {vocab.company_types.map((ct, i) => (
                <tr key={`${ct.term}-${i}`}>
                  <td className={`${TD_CLASS} font-medium text-gray-900`}>{ct.term}</td>
                  <td className={TD_CLASS}>
                    <Badge tone={(KIND_META[ct.kind] ?? KIND_META.synonym).tone}>
                      {(KIND_META[ct.kind] ?? KIND_META.synonym).label}
                    </Badge>
                  </td>
                  <td className={TD_CLASS}>{ct.geo || '—'}</td>
                  <td className={`${TD_CLASS} text-xs text-gray-500`}>{ct.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Должности */}
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
          Должности ({vocab.job_titles.length})
        </p>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className={TH_CLASS}>Должность</th>
                <th className={TH_CLASS}>Грейд</th>
                <th className={TH_CLASS}>Функция</th>
                <th className={TH_CLASS}>Гео</th>
                <th className={TH_CLASS}>Другие названия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {vocab.job_titles.map((jt, i) => (
                <tr key={`${jt.title}-${i}`}>
                  <td className={`${TD_CLASS} font-medium text-gray-900`}>{jt.title}</td>
                  <td className={TD_CLASS}>{jt.seniority || '—'}</td>
                  <td className={TD_CLASS}>{jt.function || '—'}</td>
                  <td className={TD_CLASS}>{jt.geo || '—'}</td>
                  <td className={TD_CLASS}>
                    {jt.alt_names && jt.alt_names.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {jt.alt_names.map((alt) => (
                          <span
                            key={alt}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600"
                          >
                            {alt}
                          </span>
                        ))}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Поисковые запросы */}
      {queriesBySource.length > 0 ? (
        <section>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
            <Search className="h-3.5 w-3.5" aria-hidden />
            Готовые поисковые запросы ({vocab.search_queries.length})
          </p>
          <div className="space-y-3">
            {queriesBySource.map(([source, queries]) => (
              <div key={source} className="rounded-lg border border-gray-200 bg-white p-3">
                <p className="mb-2">
                  <Badge tone="blue">{source}</Badge>
                </p>
                <ul className="space-y-1.5">
                  {queries.map((q, qi) => (
                    <li key={qi} className="text-sm text-gray-700">
                      <code className="rounded bg-gray-50 px-1.5 py-0.5 font-mono text-xs text-gray-800">
                        {q.query}
                      </code>
                      {q.purpose ? <span className="ml-2 text-xs text-gray-400">— {q.purpose}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
