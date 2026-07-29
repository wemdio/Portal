'use client';

/**
 * Шаг 3 мастера «Движка вертикалей» — «Контент вертикали»: черновая цепочка
 * писем (мастер-черновик) и вокабуляр для сбора базы. Поглощает старые
 * ChainView/VocabView. Занятость/ошибки джоб выводятся из jobs по stage.
 */

import { useMemo, useState, type JSX } from 'react';
import { ArrowRight, BarChart3, BookOpen, Mail, Search } from 'lucide-react';
import type {
  HeChain,
  HeChainLanguage,
  HeCompanyType,
  HeCompanyTypeKind,
  HeJobTitle,
  HeVocab,
  HeVertical,
} from '@/lib/hypothesisEngine/types';
import type { HeDossier, HeDossierData, HeJobSummary } from '../api';
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

/** Вердикт досье «покупает ли сегмент каналы продаж» → лейбл и тон бейджа. */
const BUYS_CHANNELS_META: Record<'yes' | 'likely' | 'unknown', { label: string; tone: BadgeTone }> = {
  yes: { label: 'Сегмент покупает каналы продаж', tone: 'emerald' },
  likely: { label: 'Вероятно покупает', tone: 'amber' },
  unknown: { label: 'Про покупку каналов данных нет', tone: 'gray' },
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
function latestStageJob(jobs: HeJobSummary[], stage: string): HeJobSummary | undefined {
  let best: HeJobSummary | undefined;
  for (const job of jobs) {
    // Сравниваем как строки: свежие стадии (напр. 'dossier') могут отставать в HeStage.
    if ((job.stage as string) !== stage) continue;
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
  /** Досье вертикалей проекта (из GET /projects/[id]). */
  dossiers?: HeDossier[];
  /** Запуск сборки досье выбранной вертикали (POST /verticals/[id]/dossier). */
  onBuildDossier?: () => void;
}): JSX.Element {
  const {
    vertical,
    chains,
    vocabs,
    jobs,
    onGenerateChain,
    onGenerateVocab,
    onGoToBase,
    dossiers,
    onBuildDossier,
  } = props;
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

  // Досье выбранной вертикали — последняя запись в выдаче.
  const dossier = useMemo(() => {
    let found: HeDossier | undefined;
    for (const d of dossiers ?? []) {
      if (d.vertical_id === vertical.id) found = d;
    }
    return found;
  }, [dossiers, vertical.id]);
  // Джоба досье привязана к вертикали через payload.vertical_id: без фильтра
  // чужая dossier-джоба показывала бы busy/error на карточке этой вертикали.
  // Джобы без payload (старые строки) вертикали не соответствуют.
  const dossierJob = useMemo(
    () => latestStageJob(jobs.filter((j) => j.payload?.vertical_id === vertical.id), 'dossier'),
    [jobs, vertical.id],
  );
  // Дедупликация: кнопка выключена, пока джоба досье pending/running (или строка ещё draft).
  const dossierBusy = jobActive(dossierJob) || dossier?.status === 'draft';
  const dossierFailed = !dossierBusy && (dossierJob?.status === 'failed' || dossier?.status === 'failed');
  const dossierReady = !dossierBusy && dossier?.status === 'ready' && dossier.data ? dossier.data : null;

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

      {/* Блок C: досье вертикали — объективные числа сегмента */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-gray-400" aria-hidden />
              <h3 className="text-sm font-semibold text-gray-800">Досье вертикали</h3>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Объективные числа сегмента: наша директория, hh.ru, статистика наших кампаний.
            </p>
          </div>
          {onBuildDossier ? (
            <button
              type="button"
              onClick={onBuildDossier}
              disabled={dossierBusy}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {dossierBusy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <BarChart3 className="h-3.5 w-3.5" aria-hidden />
              )}
              {dossierFailed ? 'Попробовать снова' : dossierReady ? 'Пересобрать' : 'Собрать досье'}
            </button>
          ) : null}
        </div>

        {dossierFailed ? (
          <div className="mt-3">
            <StatusBox tone="error">
              {dossier?.error || dossierJob?.error || 'Сборка досье завершилась ошибкой.'} Нажмите
              «Попробовать снова».
            </StatusBox>
          </div>
        ) : null}
        {dossierBusy && !dossierReady ? (
          <div className="mt-3">
            <StatusBox tone="info">Собираем досье — обычно 2–5 минут…</StatusBox>
          </div>
        ) : null}

        {dossierReady ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <DossierSegmentCard data={dossierReady} />
            <DossierSignalsCard data={dossierReady} />
            <DossierDatasetCard data={dossierReady} />
          </div>
        ) : null}
        {!dossier && !dossierBusy && !dossierFailed ? (
          <p className="mt-4 text-xs text-gray-400">Досье пока нет — нажмите «Собрать досье».</p>
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

/* ─────────────────────────── Карточки досье ─────────────────────────── */

/** Крупная цифра с подписью — «.num»-статистика карточек досье. */
function DossierNum({ value, caption }: { value: string; caption: string }) {
  return (
    <div>
      <p className="text-2xl font-bold tabular-nums text-gray-900">{value}</p>
      <p className="text-[11px] text-gray-400">{caption}</p>
    </div>
  );
}

/** «Сегмент в цифрах»: компании директории, вакансии hh, оценка размера сегмента. */
function DossierSegmentCard({ data }: { data: HeDossierData }) {
  const { counters, interpretation } = data;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">Сегмент в цифрах</p>
      <div className="space-y-3">
        {counters.companies_total != null ? (
          <div>
            <DossierNum
              value={`~${counters.companies_total.toLocaleString('ru-RU')}`}
              caption="компаний в директории"
            />
            {counters.companies_note ? (
              <p className="mt-0.5 text-[11px] text-gray-400">{counters.companies_note}</p>
            ) : null}
          </div>
        ) : null}
        {counters.hh_vacancies_total != null ? (
          <div>
            <DossierNum
              value={counters.hh_vacancies_total.toLocaleString('ru-RU')}
              caption="вакансий на hh.ru"
            />
            {counters.hh_vacancies_sample.length > 0 ? (
              <details className="group mt-1">
                <summary className="cursor-pointer list-none text-[11px] font-medium text-gray-500 hover:text-gray-700">
                  Примеры вакансий ({counters.hh_vacancies_sample.length})
                </summary>
                <ul className="mt-1 space-y-0.5 border-l-2 border-gray-100 pl-2 text-[11px] text-gray-500">
                  {counters.hh_vacancies_sample.map((title, i) => (
                    <li key={i}>{title}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
        {interpretation.segment_size_assessment ? (
          <p>
            <Badge tone="blue">{interpretation.segment_size_assessment}</Badge>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** «Сигналы боли»: список сигналов из счётчиков (метка + значение). */
function DossierSignalsCard({ data }: { data: HeDossierData }) {
  const { signals } = data.counters;
  // У старых досье поля вердикта нет — тогда блок не рендерим вообще.
  const buysChannels = data.interpretation.buys_sales_channels;
  const buysMeta = buysChannels ? BUYS_CHANNELS_META[buysChannels] : undefined;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">Сигналы боли</p>
      {signals.length === 0 ? (
        <p className="text-xs text-gray-400">Сигналов не найдено.</p>
      ) : (
        <ul className="space-y-1.5">
          {signals.map((s, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 text-gray-600" title={s.source}>
                {s.label}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-gray-900">{s.value}</span>
            </li>
          ))}
        </ul>
      )}
      {buysMeta ? (
        <div className="mt-3 border-t border-gray-200 pt-2">
          <Badge tone={buysMeta.tone}>{buysMeta.label}</Badge>
          {data.interpretation.buys_sales_channels_reason ? (
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              {data.interpretation.buys_sales_channels_reason}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** «Наши кампании»: reply против базового, охват, сегменты, лучшие темы, выводы. */
function DossierDatasetCard({ data }: { data: HeDossierData }) {
  const { dataset_stats: ds, interpretation } = data;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">Наши кампании</p>
      {ds.reply_pct != null || ds.baseline_pct != null ? (
        <div className="flex flex-wrap gap-6">
          {ds.reply_pct != null ? <DossierNum value={`${ds.reply_pct}%`} caption="reply в вертикали" /> : null}
          {ds.baseline_pct != null ? (
            <DossierNum value={`${ds.baseline_pct}%`} caption="в среднем по базе" />
          ) : null}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-gray-400">
        {ds.campaigns.toLocaleString('ru-RU')} кампаний · {ds.sent.toLocaleString('ru-RU')} отправлено ·{' '}
        {ds.replies.toLocaleString('ru-RU')} ответов
      </p>
      {ds.note ? <p className="mt-1 text-[11px] text-gray-400">{ds.note}</p> : null}
      {ds.matched_segments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {ds.matched_segments.map((seg) => (
            <span key={seg} className="rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-600 ring-1 ring-gray-200">
              {seg}
            </span>
          ))}
        </div>
      ) : null}
      {ds.top_subjects.length > 0 ? (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-gray-500 hover:text-gray-700">
            Лучшие темы ({ds.top_subjects.length})
          </summary>
          <ul className="mt-1 space-y-0.5 border-l-2 border-gray-100 pl-2 text-[11px] text-gray-500">
            {ds.top_subjects.map((subj, i) => (
              <li key={i}>{subj}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {interpretation.dataset_verdict ? (
        <p className="mt-2 text-xs leading-relaxed text-gray-500">{interpretation.dataset_verdict}</p>
      ) : null}
      {interpretation.market_summary ? (
        <p className="mt-1 text-xs leading-relaxed text-gray-400">{interpretation.market_summary}</p>
      ) : null}
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
