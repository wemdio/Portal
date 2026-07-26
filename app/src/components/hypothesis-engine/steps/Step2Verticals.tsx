'use client';

/**
 * Шаг 2 мастера «Движка вертикалей» — выбор направления.
 * Карточки по rank: название, потенциал, короткое саммари; синонимы спрятаны
 * за «Подробнее», гипотезы с доказательствами — в раскрываемом блоке
 * (accept/reject как в старой доске, оптимистично через onPatchHypothesis).
 * Главное действие карточки — «Выбрать это направление →» (onSelectVertical).
 */

import { useMemo, useState, type JSX } from 'react';
import { Check, ChevronDown, ExternalLink, X } from 'lucide-react';
import type { HeHypothesis, HeStage, HeVertical } from '@/lib/hypothesisEngine/types';
import { Badge, PotentialBadge, Spinner, TierBadge } from '../ui';
import type { HeJobSummary, HeProjectDetailResponse } from '../api';

/** Стадии досборки материалов под выбранную вертикаль (письма/вокабуляр/шаблон). */
const BUILD_STAGES: ReadonlySet<HeStage> = new Set(['chain', 'vocab', 'template']);

type HypothesisPatchStatus = 'accepted' | 'rejected' | 'proposed';

/** 1 направление, 2–4 направления, 5+ направлений. */
function pluralDirections(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'направление';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'направления';
  return 'направлений';
}

export interface Step2VerticalsProps {
  verticals: HeProjectDetailResponse['verticals'];
  hypotheses: HeProjectDetailResponse['hypotheses'];
  selectedVerticalId: string | null;
  onPatchHypothesis: (id: string, status: HypothesisPatchStatus) => void;
  onSelectVertical: (id: string) => void;
  jobs: HeJobSummary[];
}

export function Step2Verticals({
  verticals,
  hypotheses,
  selectedVerticalId,
  onPatchHypothesis,
  onSelectVertical,
  jobs,
}: Step2VerticalsProps): JSX.Element {
  const sorted = useMemo(
    () =>
      [...(verticals ?? [])].sort((a, b) => {
        const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
        const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return b.potential_pct - a.potential_pct;
      }),
    [verticals],
  );

  const hypothesesByVertical = useMemo(() => {
    const map = new Map<string, HeHypothesis[]>();
    for (const h of hypotheses ?? []) {
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

  // У джобы нет привязки к вертикали, поэтому заметку о досборке показываем
  // на выбранной карточке — именно под неё собираются материалы.
  const buildActive = jobs.some(
    (j) => BUILD_STAGES.has(j.stage) && (j.status === 'pending' || j.status === 'running'),
  );

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-800 bg-gray-900/50 p-10 text-center">
        <p className="text-sm font-medium text-gray-400">Вертикалей пока нет</p>
        <p className="mt-1 text-xs text-gray-500">
          Дождитесь окончания исследования — направления появятся здесь.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Движок нашёл {sorted.length} {pluralDirections(sorted.length)}. Выберите одно — под него соберём письма,
        вокабуляр и шаблон.
      </p>
      {sorted.map((vertical) => (
        <VerticalCard
          key={vertical.id}
          vertical={vertical}
          hypotheses={hypothesesByVertical.get(vertical.id) ?? []}
          selected={vertical.id === selectedVerticalId}
          buildNote={vertical.id === selectedVerticalId && buildActive}
          onSelectVertical={onSelectVertical}
          onPatchHypothesis={onPatchHypothesis}
        />
      ))}
    </div>
  );
}

/* ─────────────────────────── Карточка ─────────────────────────── */

function VerticalCard({
  vertical,
  hypotheses,
  selected,
  buildNote,
  onSelectVertical,
  onPatchHypothesis,
}: {
  vertical: HeVertical;
  hypotheses: HeHypothesis[];
  selected: boolean;
  buildNote: boolean;
  onSelectVertical: (id: string) => void;
  onPatchHypothesis: (id: string, status: HypothesisPatchStatus) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const acceptedCount = hypotheses.filter((h) => h.status === 'accepted').length;

  return (
    <article
      className={`rounded-xl border p-5 transition ${
        selected ? 'border-emerald-600 bg-gray-900 ring-1 ring-emerald-600/50' : 'border-gray-800 bg-gray-900'
      }`}
    >
      {/* Шапка: rank, название, потенциал */}
      <div className="flex flex-wrap items-center gap-2">
        {vertical.rank != null ? (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-800 text-[11px] font-bold text-gray-400">
            {vertical.rank}
          </span>
        ) : null}
        <h3 className="text-base font-semibold text-gray-100">{vertical.name}</h3>
        <PotentialBadge pct={vertical.potential_pct} />
        {selected ? <Badge tone="emerald">Выбрано</Badge> : null}
      </div>

      {vertical.summary ? (
        <p className={`mt-2 text-sm leading-relaxed text-gray-400 ${showDetails ? '' : 'line-clamp-2'}`}>
          {vertical.summary}
        </p>
      ) : null}

      {/* Синонимы — за «Подробнее», чтобы не шуметь */}
      {vertical.synonyms.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${showDetails ? 'rotate-180' : ''}`}
              aria-hidden
            />
            {showDetails ? 'Скрыть' : 'Подробнее'}
          </button>
          {showDetails ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {vertical.synonyms.map((syn) => (
                <span key={syn} className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-400">
                  {syn}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Гипотезы вертикали */}
      {hypotheses.length > 0 ? (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-gray-400 hover:text-gray-200">
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
            Гипотезы ({hypotheses.length}
            {acceptedCount > 0 ? `, принято ${acceptedCount}` : ''})
          </summary>
          <ul className="mt-3 space-y-2">
            {hypotheses.map((h) => (
              <HypothesisItem key={h.id} hypothesis={h} onPatch={onPatchHypothesis} />
            ))}
          </ul>
        </details>
      ) : null}

      {/* Главное действие */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => onSelectVertical(vertical.id)}
          disabled={selected}
          className={
            selected
              ? 'inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-800 bg-emerald-950/50 px-4 py-2.5 text-sm font-semibold text-emerald-300'
              : 'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500'
          }
        >
          {selected ? (
            <>
              <Check className="h-4 w-4" aria-hidden />
              Выбрано
            </>
          ) : (
            'Выбрать это направление →'
          )}
        </button>
        {buildNote ? (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-gray-500">
            <Spinner className="h-3 w-3" />
            Собираем письма, вокабуляр и шаблон…
          </p>
        ) : null}
      </div>
    </article>
  );
}

/* ─────────────────────────── Гипотеза ─────────────────────────── */

function HypothesisItem({
  hypothesis,
  onPatch,
}: {
  hypothesis: HeHypothesis;
  onPatch: (id: string, status: HypothesisPatchStatus) => void;
}) {
  const rejected = hypothesis.status === 'rejected';
  const accepted = hypothesis.status === 'accepted';

  return (
    <li
      className={`rounded-lg border p-3 transition ${
        rejected
          ? 'border-gray-800 bg-gray-950/40 opacity-60'
          : accepted
            ? 'border-emerald-800/70 bg-emerald-950/20'
            : 'border-gray-800 bg-gray-950/60'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <TierBadge tier={hypothesis.tier} />
            <p className="text-sm font-semibold text-gray-100">{hypothesis.title}</p>
            <PotentialBadge pct={hypothesis.potential_pct} />
            {accepted ? <Badge tone="emerald">Принята</Badge> : null}
            {rejected ? <Badge tone="gray">Отклонена</Badge> : null}
          </div>
          {hypothesis.description ? (
            <p className="mt-1 text-sm leading-relaxed text-gray-400">{hypothesis.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onPatch(hypothesis.id, accepted ? 'proposed' : 'accepted')}
            title={accepted ? 'Снять принятие' : 'Принять гипотезу'}
            aria-pressed={accepted}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${
              accepted
                ? 'border-emerald-700 bg-emerald-950/60 text-emerald-300'
                : 'border-gray-700 text-gray-500 hover:border-emerald-700 hover:text-emerald-400'
            }`}
          >
            <Check className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onPatch(hypothesis.id, rejected ? 'proposed' : 'rejected')}
            title={rejected ? 'Вернуть в предложенные' : 'Отклонить гипотезу'}
            aria-pressed={rejected}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition ${
              rejected
                ? 'border-red-800 bg-red-950/50 text-red-300'
                : 'border-gray-700 text-gray-500 hover:border-red-800 hover:text-red-400'
            }`}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {hypothesis.evidence.length > 0 ? (
        <details className="group/ev mt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-300">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open/ev:rotate-180" aria-hidden />
            Доказательства ({hypothesis.evidence.length})
          </summary>
          <ul className="mt-2 space-y-2 border-l-2 border-gray-800 pl-3">
            {hypothesis.evidence.map((ev, ei) => (
              <li key={ei} className="text-xs leading-relaxed">
                <p className="italic text-gray-400">«{ev.quote}»</p>
                <p className="mt-0.5 text-gray-500">{ev.claim}</p>
                <a
                  href={ev.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-flex items-center gap-1 break-all text-blue-400 hover:text-blue-300"
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
