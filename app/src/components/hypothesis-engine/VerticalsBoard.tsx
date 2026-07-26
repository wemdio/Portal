'use client';

/**
 * Доска вертикалей проекта: карточки, отсортированные по rank, с бейджем
 * потенциала, синонимами, раскрываемыми гипотезами (accept/reject + доказательства)
 * и кнопками «Цепочка писем» / «Вокабуляр» со спиннерами по состоянию джоб.
 */

import { useMemo, useState } from 'react';
import { Check, ChevronDown, ExternalLink, Loader2, Mail, BookOpen, X } from 'lucide-react';
import type {
  HeChain,
  HeChainLanguage,
  HeHypothesis,
  HeHypothesisStatus,
  HeVocab,
  HeVertical,
} from '@/lib/hypothesisEngine/types';
import { watchedJobState, type HeJobSummary } from './api';
import { ChainView } from './ChainView';
import { VocabView } from './VocabView';
import { Badge, PotentialBadge, TierBadge } from './ui';

const LANG_OPTIONS: Array<{ value: HeChainLanguage; label: string }> = [
  { value: 'ru', label: 'RU' },
  { value: 'en', label: 'EN' },
  { value: 'pl', label: 'PL' },
];

function latestByCreatedAt<T extends { created_at: string }>(items: T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (!best || item.created_at > best.created_at) best = item;
  }
  return best;
}

interface VerticalsBoardProps {
  verticals: HeVertical[];
  hypotheses: HeHypothesis[];
  chains: HeChain[];
  vocabs: HeVocab[];
  jobs: HeJobSummary[];
  chainJobs: Record<string, string>;
  vocabJobs: Record<string, string>;
  hypBusyId: string | null;
  onRunChain: (verticalId: string, language: HeChainLanguage) => void;
  onRunVocab: (verticalId: string) => void;
  onPatchHypothesis: (id: string, status: HeHypothesisStatus) => void;
}

export function VerticalsBoard(props: VerticalsBoardProps) {
  const { verticals, hypotheses } = props;

  const sorted = useMemo(
    () =>
      [...verticals].sort((a, b) => {
        const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
        const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return b.potential_pct - a.potential_pct;
      }),
    [verticals],
  );

  const hypothesesByVertical = useMemo(() => {
    const map = new Map<string, HeHypothesis[]>();
    for (const h of hypotheses) {
      if (!h.vertical_id) continue;
      const list = map.get(h.vertical_id) ?? [];
      list.push(h);
      map.set(h.vertical_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.potential_pct - a.potential_pct || a.tier - b.tier);
    }
    return map;
  }, [hypotheses]);

  if (sorted.length === 0) {
    return (
      <div className="flex min-h-[180px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 p-10 text-center">
        <p className="text-sm font-medium text-gray-500">Вертикалей пока нет</p>
        <p className="mt-1 text-xs text-gray-400">
          Запустите исследование — после стадии кластеризации здесь появятся вертикали с гипотезами.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sorted.map((vertical) => (
        <VerticalCard
          key={vertical.id}
          {...props}
          vertical={vertical}
          hypotheses={hypothesesByVertical.get(vertical.id) ?? []}
        />
      ))}
    </div>
  );
}

interface VerticalCardProps extends VerticalsBoardProps {
  vertical: HeVertical;
}

function VerticalCard({
  vertical,
  hypotheses,
  chains,
  vocabs,
  jobs,
  chainJobs,
  vocabJobs,
  hypBusyId,
  onRunChain,
  onRunVocab,
  onPatchHypothesis,
}: VerticalCardProps) {
  const [language, setLanguage] = useState<HeChainLanguage>('ru');

  const chain = useMemo(
    () => latestByCreatedAt(chains.filter((c) => c.vertical_id === vertical.id)),
    [chains, vertical.id],
  );
  const vocab = useMemo(
    () => latestByCreatedAt(vocabs.filter((v) => v.vertical_id === vertical.id)),
    [vocabs, vertical.id],
  );

  const chainJobState = watchedJobState(jobs, chainJobs[vertical.id]);
  const vocabJobState = watchedJobState(jobs, vocabJobs[vertical.id]);
  // Подстраховка: если сама запись в статусе генерации — тоже крутим спиннер.
  const chainBusy =
    chainJobState === 'active' || chain?.status === 'generating' || chain?.status === 'pending';
  const vocabBusy = vocabJobState === 'active';

  const chainJobError =
    chainJobState === 'failed'
      ? (jobs.find((j) => j.id === chainJobs[vertical.id])?.error ?? null)
      : null;

  const acceptedCount = hypotheses.filter((h) => h.status === 'accepted').length;

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-5">
      {/* Шапка вертикали */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {vertical.rank != null ? (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[11px] font-bold text-gray-500">
                {vertical.rank}
              </span>
            ) : null}
            <h3 className="text-base font-semibold text-gray-900">{vertical.name}</h3>
            <PotentialBadge pct={vertical.potential_pct} />
          </div>
          {vertical.synonyms.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {vertical.synonyms.map((syn) => (
                <span key={syn} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
                  {syn}
                </span>
              ))}
            </div>
          ) : null}
          {vertical.summary ? (
            <p className="mt-2 text-sm leading-relaxed text-gray-600">{vertical.summary}</p>
          ) : null}
        </div>
      </div>

      {/* Гипотезы вертикали */}
      {hypotheses.length > 0 ? (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-800">
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
            Гипотезы ({hypotheses.length}
            {acceptedCount > 0 ? `, принято ${acceptedCount}` : ''})
          </summary>
          <ul className="mt-3 space-y-2">
            {hypotheses.map((h) => (
              <HypothesisItem
                key={h.id}
                hypothesis={h}
                busy={hypBusyId === h.id}
                onPatch={onPatchHypothesis}
              />
            ))}
          </ul>
        </details>
      ) : null}

      {/* Действия */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center overflow-hidden rounded-lg border border-gray-200">
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
            onClick={() => onRunChain(vertical.id, language)}
            disabled={chainBusy}
            title="Сначала черновик; боевой шаблон собирается во вкладке „Базы“"
            className="inline-flex h-9 items-center gap-1.5 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {chainBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Mail className="h-3.5 w-3.5" aria-hidden />
            )}
            {chain ? 'Пересобрать цепочку' : 'Цепочка писем'}
          </button>
        </div>
        <button
          type="button"
          onClick={() => onRunVocab(vertical.id)}
          disabled={vocabBusy}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {vocabBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
          )}
          {vocab ? 'Обновить вокабуляр' : 'Вокабуляр'}
        </button>
      </div>

      {/* Результаты */}
      {chain || chainJobState === 'failed' ? (
        <div className="mt-4">
          {chain ? (
            <ChainView chain={chain} error={chainJobError} />
          ) : (
            <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              {chainJobError || 'Генерация цепочки завершилась ошибкой.'}
            </p>
          )}
        </div>
      ) : null}
      {vocab ? (
        <div className="mt-4">
          <VocabView vocab={vocab} />
        </div>
      ) : null}
    </article>
  );
}

function HypothesisItem({
  hypothesis,
  busy,
  onPatch,
}: {
  hypothesis: HeHypothesis;
  busy: boolean;
  onPatch: (id: string, status: HeHypothesisStatus) => void;
}) {
  const rejected = hypothesis.status === 'rejected';
  const accepted = hypothesis.status === 'accepted';

  return (
    <li
      className={`rounded-lg border p-3 transition ${
        rejected
          ? 'border-gray-100 bg-gray-50/60 opacity-60'
          : accepted
            ? 'border-emerald-200 bg-emerald-50/40'
            : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <TierBadge tier={hypothesis.tier} />
            <p className="text-sm font-semibold text-gray-900">{hypothesis.title}</p>
            <PotentialBadge pct={hypothesis.potential_pct} />
            {accepted ? <Badge tone="emerald">Принята</Badge> : null}
            {rejected ? <Badge tone="gray">Отклонена</Badge> : null}
          </div>
          {hypothesis.description ? (
            <p className="mt-1 text-sm leading-relaxed text-gray-600">{hypothesis.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => onPatch(hypothesis.id, accepted ? 'proposed' : 'accepted')}
            title={accepted ? 'Снять принятие' : 'Принять гипотезу'}
            aria-pressed={accepted}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:opacity-50 ${
              accepted
                ? 'border-emerald-300 bg-emerald-100 text-emerald-700'
                : 'border-gray-200 bg-white text-gray-400 hover:border-emerald-200 hover:text-emerald-600'
            }`}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Check className="h-4 w-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPatch(hypothesis.id, rejected ? 'proposed' : 'rejected')}
            title={rejected ? 'Вернуть в предложенные' : 'Отклонить гипотезу'}
            aria-pressed={rejected}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:opacity-50 ${
              rejected
                ? 'border-red-300 bg-red-100 text-red-600'
                : 'border-gray-200 bg-white text-gray-400 hover:border-red-200 hover:text-red-500'
            }`}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <X className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {hypothesis.evidence.length > 0 ? (
        <details className="group/ev mt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open/ev:rotate-180" aria-hidden />
            Доказательства ({hypothesis.evidence.length})
          </summary>
          <ul className="mt-2 space-y-2 border-l-2 border-gray-100 pl-3">
            {hypothesis.evidence.map((ev, ei) => (
              <li key={ei} className="text-xs leading-relaxed">
                <p className="italic text-gray-600">«{ev.quote}»</p>
                <p className="mt-0.5 text-gray-500">{ev.claim}</p>
                <a
                  href={ev.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-flex items-center gap-1 break-all text-blue-600 hover:text-blue-700"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                  {ev.source_url}
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
