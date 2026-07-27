'use client';

/**
 * Шаг 3 мастера «Движка вертикалей» — «Контент вертикали»: черновая цепочка
 * писем (мастер-черновик) и вокабуляр для сбора базы. Поглощает старые
 * ChainView/VocabView. Занятость/ошибки джоб выводятся из jobs по stage.
 */

import { useMemo, useState, type JSX } from 'react';
import { ArrowRight, BookOpen, Mail, Search } from 'lucide-react';
import type {
  HeChain,
  HeChainLanguage,
  HeCompanyType,
  HeCompanyTypeKind,
  HeJobTitle,
  HeVocab,
  HeVertical,
} from '@/lib/hypothesisEngine/types';
import type { HeJobSummary } from '../api';
import { Badge, PotentialBadge, Spinner, StatusBox, type BadgeTone } from '../ui';

const LANG_OPTIONS: Array<{ value: HeChainLanguage; label: string }> = [
  { value: 'ru', label: 'RU' },
  { value: 'en', label: 'EN' },
  { value: 'pl', label: 'PL' },
];

const LANG_LABEL: Record<string, string> = { ru: 'RU', en: 'EN', pl: 'PL' };

const KIND_ORDER: HeCompanyTypeKind[] = ['canonical', 'synonym', 'geo_variant', 'adjacent', 'slang'];

const KIND_META: Record<HeCompanyTypeKind, { label: string; tone: BadgeTone }> = {
  canonical: { label: 'Каноническое', tone: 'emerald' },
  synonym: { label: 'Синоним', tone: 'blue' },
  geo_variant: { label: 'Гео-вариант', tone: 'amber' },
  adjacent: { label: 'Смежное', tone: 'violet' },
  slang: { label: 'Сленг', tone: 'gray' },
};

/** На новых данных должность может нести audience_side; на старых поля нет. */
type JobTitleRow = HeJobTitle & { audience_side?: string };

function latestByCreatedAt<T extends { created_at: string }>(items: T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (!best || item.created_at > best.created_at) best = item;
  }
  return best;
}

/** Последняя джоба стадии (по started_at; записи без started_at считаются старыми). */
function latestStageJob(jobs: HeJobSummary[], stage: HeJobSummary['stage']): HeJobSummary | undefined {
  let best: HeJobSummary | undefined;
  for (const job of jobs) {
    if (job.stage !== stage) continue;
    if (!best || (job.started_at ?? '') >= (best.started_at ?? '')) best = job;
  }
  return best;
}

function jobActive(job: HeJobSummary | undefined): boolean {
  return job?.status === 'pending' || job?.status === 'running';
}

/** Нормализация источника поискового запроса в короткий лейбл группы. */
function sourceLabel(source: string): string {
  const s = source.toLowerCase();
  if (s.includes('hh')) return 'HH';
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('реестр') || s.includes('registr')) return 'Реестры';
  if (s.includes('карт') || s.includes('map') || s.includes('gis')) return 'Карты';
  return source;
}

export function Step3Content(props: {
  vertical: HeVertical;
  chains: HeChain[];
  vocabs: HeVocab[];
  jobs: HeJobSummary[];
  onGenerateChain: (language: 'ru' | 'en' | 'pl') => void;
  onGenerateVocab: () => void;
  onGoToBase: () => void;
}): JSX.Element {
  const { vertical, chains, vocabs, jobs, onGenerateChain, onGenerateVocab, onGoToBase } = props;
  const [language, setLanguage] = useState<HeChainLanguage>('ru');

  const chain = useMemo(
    () => latestByCreatedAt(chains.filter((c) => c.vertical_id === vertical.id)),
    [chains, vertical.id],
  );
  const vocab = useMemo(
    () => latestByCreatedAt(vocabs.filter((v) => v.vertical_id === vertical.id)),
    [vocabs, vertical.id],
  );

  const chainJob = useMemo(() => latestStageJob(jobs, 'chain'), [jobs]);
  const vocabJob = useMemo(() => latestStageJob(jobs, 'vocab'), [jobs]);
  const chainBusy =
    jobActive(chainJob) || chain?.status === 'generating' || chain?.status === 'pending';
  const vocabBusy = jobActive(vocabJob);
  const chainFailed = !chainBusy && (chainJob?.status === 'failed' || chain?.status === 'failed');
  const vocabFailed = !vocabBusy && vocabJob?.status === 'failed';

  return (
    <div className="space-y-5">
      {/* Контекст шага */}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-gray-900">{vertical.name}</h2>
          <PotentialBadge pct={vertical.potential_pct} />
        </div>
        <p className="mt-1 text-sm text-gray-400">
          Черновые материалы под это направление. Боевой текст собирается на шаге 4–5 из загруженной
          базы.
        </p>
      </header>

      {/* Блок A: цепочка писем (черновик) */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Mail className="h-4 w-4 text-gray-400" aria-hidden />
              <h3 className="text-sm font-semibold text-gray-800">Цепочка писем (черновик)</h3>
              {chain ? (
                <Badge tone="blue">{LANG_LABEL[chain.language] ?? chain.language.toUpperCase()}</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Мастер-черновик. В рассылку не идёт — основа для шаблона.
            </p>
          </div>
          <div className="inline-flex shrink-0 items-center overflow-hidden rounded-lg border border-gray-200">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as HeChainLanguage)}
              disabled={chainBusy}
              aria-label="Язык цепочки"
              className="h-9 border-r border-gray-200 bg-gray-50 px-2 text-xs font-medium text-gray-600 focus:outline-none disabled:opacity-50"
            >
              {LANG_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onGenerateChain(language)}
              disabled={chainBusy}
              className="inline-flex h-9 items-center gap-1.5 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {chainBusy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Mail className="h-3.5 w-3.5" aria-hidden />
              )}
              {chainFailed ? 'Попробовать снова' : chain ? 'Перегенерировать' : 'Сгенерировать'}
            </button>
          </div>
        </div>

        {chainFailed ? (
          <div className="mt-3">
            <StatusBox tone="error">
              {chainJob?.error || 'Генерация цепочки завершилась ошибкой.'} Нажмите «Попробовать
              снова».
            </StatusBox>
          </div>
        ) : null}
        {chainBusy && !chain ? (
          <div className="mt-3">
            <StatusBox tone="info">Генерируем черновую цепочку — обычно 1–2 минуты…</StatusBox>
          </div>
        ) : null}

        {chain && chain.letters.length > 0 ? (
          <ol className="mt-4 space-y-3">
            {chain.letters.map((letter, idx) => (
              <li key={idx} className="rounded-lg border border-gray-200 bg-gray-50/50 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700">
                    {idx + 1}
                  </span>
                  {letter.subject ? (
                    <p className="text-sm font-semibold text-gray-900">{letter.subject}</p>
                  ) : (
                    <p className="text-sm italic text-gray-400">Без темы</p>
                  )}
                  {letter.wait_days > 0 ? (
                    <span className="text-[11px] text-gray-400">через {letter.wait_days} дн.</span>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {letter.body}
                </p>
                {letter.variants && letter.variants.length > 0 ? (
                  <details className="group mt-2">
                    <summary className="cursor-pointer list-none text-xs font-medium text-gray-500 hover:text-gray-700">
                      Варианты ({letter.variants.length})
                    </summary>
                    <div className="mt-2 space-y-2 border-l-2 border-gray-100 pl-3">
                      {letter.variants.map((v, vi) => (
                        <p
                          key={vi}
                          className="whitespace-pre-wrap text-xs leading-relaxed text-gray-500"
                        >
                          {v}
                        </p>
                      ))}
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {!chain && !chainBusy && !chainFailed ? (
          <p className="mt-4 text-xs text-gray-400">
            Цепочки пока нет — выберите язык и нажмите «Сгенерировать».
          </p>
        ) : null}
      </section>

      {/* Блок B: вокабуляр для сбора базы */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-gray-400" aria-hidden />
              <h3 className="text-sm font-semibold text-gray-800">Вокабуляр для сбора базы</h3>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Технический слой: по этим терминам ищем компании и должности в HH/картах/реестрах. В
              письмах не используется.
            </p>
          </div>
          <button
            type="button"
            onClick={onGenerateVocab}
            disabled={vocabBusy}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {vocabBusy ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
            )}
            {vocabFailed ? 'Попробовать снова' : vocab ? 'Перегенерировать' : 'Сгенерировать'}
          </button>
        </div>

        {vocabFailed ? (
          <div className="mt-3">
            <StatusBox tone="error">
              {vocabJob?.error || 'Генерация вокабуляра завершилась ошибкой.'} Нажмите «Попробовать
              снова».
            </StatusBox>
          </div>
        ) : null}
        {vocabBusy && !vocab ? (
          <div className="mt-3">
            <StatusBox tone="info">Собираем вокабуляр — обычно 1–2 минуты…</StatusBox>
          </div>
        ) : null}

        {vocab ? (
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <div className="xl:col-span-2">
              <JobTitlesCard jobTitles={(vocab.job_titles ?? []) as JobTitleRow[]} />
            </div>
            <CompanyTypesCard companyTypes={vocab.company_types ?? []} />
            <QueriesCard queries={vocab.search_queries ?? []} />
          </div>
        ) : null}
        {!vocab && !vocabBusy && !vocabFailed ? (
          <p className="mt-4 text-xs text-gray-400">Вокабуляра пока нет — нажмите «Сгенерировать».</p>
        ) : null}
      </section>

      {/* Переход к шагу «База» — всегда доступен */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onGoToBase}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          Далее: загрузить базу
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Карточки вокабуляра ─────────────────────────── */

function CompanyTypesCard({ companyTypes }: { companyTypes: HeCompanyType[] }) {
  const grouped = useMemo(() => {
    const map = new Map<HeCompanyTypeKind, HeCompanyType[]>();
    for (const ct of companyTypes) {
      const list = map.get(ct.kind) ?? [];
      list.push(ct);
      map.set(ct.kind, list);
    }
    const ordered = KIND_ORDER.filter((k) => map.has(k));
    for (const k of map.keys()) {
      if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered.map((kind) => ({ kind, items: map.get(kind)! }));
  }, [companyTypes]);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
        Типы компаний ({companyTypes.length})
      </p>
      {grouped.length === 0 ? (
        <p className="text-xs text-gray-400">Пусто.</p>
      ) : (
        <div className="space-y-2.5">
          {grouped.map(({ kind, items }) => {
            const meta = KIND_META[kind] ?? KIND_META.synonym;
            return (
              <div key={kind}>
                <p className="mb-1">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </p>
                <div className="flex flex-wrap gap-1">
                  {items.map((ct, i) => (
                    <span
                      key={`${ct.term}-${i}`}
                      title={ct.notes}
                      className="rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-600 ring-1 ring-gray-200"
                    >
                      {ct.term}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JobTitlesCard({ jobTitles }: { jobTitles: JobTitleRow[] }) {
  const hasSide = jobTitles.some((jt) => jt.audience_side);
  const buyerRows = hasSide
    ? jobTitles.filter((jt) => jt.audience_side !== 'campaign_target')
    : jobTitles;
  const targetRows = hasSide ? jobTitles.filter((jt) => jt.audience_side === 'campaign_target') : [];

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
        Должности ({jobTitles.length})
      </p>
      {jobTitles.length === 0 ? (
        <p className="text-xs text-gray-400">Пусто.</p>
      ) : hasSide ? (
        <div className="space-y-3">
          <JobTitlesTable title="Кому продаём" rows={buyerRows} />
          <JobTitlesTable title="Кого достаём клиенту" rows={targetRows} />
        </div>
      ) : (
        <JobTitlesTable rows={jobTitles} />
      )}
    </div>
  );
}

function JobTitlesTable({ title, rows }: { title?: string; rows: JobTitleRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      {title ? <p className="mb-1 text-[11px] font-semibold text-gray-500">{title}</p> : null}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Должность</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Грейд</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Функция</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Другие названия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((jt, i) => (
              <tr key={`${jt.title}-${i}`}>
                <td className="px-2 py-1.5 align-top font-medium text-gray-900">{jt.title}</td>
                <td className="px-2 py-1.5 align-top text-gray-600">{jt.seniority || '—'}</td>
                <td className="px-2 py-1.5 align-top text-gray-600">{jt.function || '—'}</td>
                <td className="px-2 py-1.5 align-top">
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
    </div>
  );
}

function QueriesCard({ queries }: { queries: HeVocab['search_queries'] }) {
  const grouped = useMemo(() => {
    const map = new Map<string, HeVocab['search_queries']>();
    for (const q of queries) {
      const key = sourceLabel(q.source || 'Прочее');
      const list = map.get(key) ?? [];
      list.push(q);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [queries]);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
        <Search className="h-3.5 w-3.5" aria-hidden />
        Поисковые запросы ({queries.length})
      </p>
      {grouped.length === 0 ? (
        <p className="text-xs text-gray-400">Пусто.</p>
      ) : (
        <div className="space-y-2.5">
          {grouped.map(([source, list]) => (
            <div key={source}>
              <p className="mb-1">
                <Badge tone="blue">{source}</Badge>
              </p>
              <div className="flex flex-wrap gap-1">
                {list.map((q, qi) => (
                  <code
                    key={qi}
                    title={q.purpose}
                    className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-gray-700 ring-1 ring-gray-200"
                  >
                    {q.query}
                  </code>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
