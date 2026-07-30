'use client';

/**
 * Шаг 2 мастера «Движка вертикалей» — выбор направления.
 * Карточки по rank: название, потенциал, короткое саммари; синонимы спрятаны
 * за «Подробнее», гипотезы с доказательствами — в раскрываемом блоке
 * (accept/reject как в старой доске, оптимистично через onPatchHypothesis).
 * Главное действие карточки — «Выбрать это направление →» (onSelectVertical).
 * Чтобы разметка десятков гипотез не утомляла: над доской фильтр-чипы и
 * «Свернуть/развернуть все», на карточке — шеврон-коллапс до одной строки и
 * тихие массовые действия «принять все / отклонить все / сбросить».
 */

import { useMemo, useState, type JSX } from 'react';
import { Check, ChevronDown, ExternalLink, X } from 'lucide-react';
import type { HeHypothesis, HeStage, HeVertical } from '@/lib/hypothesisEngine/types';
import { Badge, PotentialBadge, Spinner, TierBadge } from '../ui';
import type { HeDossier, HeJobSummary, HeProjectDetailResponse } from '../api';

/** Стадии досборки материалов под выбранную вертикаль (письма/вокабуляр/шаблон). */
const BUILD_STAGES: ReadonlySet<HeStage> = new Set(['chain', 'vocab', 'template']);

type HypothesisPatchStatus = 'accepted' | 'rejected' | 'proposed';

/** Русская плюрализация: one = 1, few = 2–4, many = 5+. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** 1 направление, 2–4 направления, 5+ направлений. */
function pluralDirections(n: number): string {
  return pluralRu(n, 'направление', 'направления', 'направлений');
}

/** 1 гипотеза, 2–4 гипотезы, 5+ гипотез. */
function pluralHypotheses(n: number): string {
  return pluralRu(n, 'гипотеза', 'гипотезы', 'гипотез');
}

/** Фильтр гипотез внутри карточек: все, по тиру или по статусу разметки. */
type HypothesisFilter = 'all' | 't1' | 't2' | 't3' | 'accepted' | 'rejected';

const FILTER_CHIPS: ReadonlyArray<{ id: HypothesisFilter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 't1', label: 'T1' },
  { id: 't2', label: 'T2' },
  { id: 't3', label: 'T3' },
  { id: 'accepted', label: 'Принятые' },
  { id: 'rejected', label: 'Отклонённые' },
];

function matchesFilter(h: HeHypothesis, filter: HypothesisFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 't1':
      return h.tier === 1;
    case 't2':
      return h.tier === 2;
    case 't3':
      return h.tier === 3;
    case 'accepted':
      return h.status === 'accepted';
    case 'rejected':
      return h.status === 'rejected';
  }
}

export interface Step2VerticalsProps {
  verticals: HeProjectDetailResponse['verticals'];
  hypotheses: HeProjectDetailResponse['hypotheses'];
  selectedVerticalId: string | null;
  onPatchHypothesis: (id: string, status: HypothesisPatchStatus) => void;
  onSelectVertical: (id: string) => void;
  jobs: HeJobSummary[];
  /** Досье вертикалей (для компактной строки цифр на готовых). */
  dossiers?: HeDossier[];
}

export function Step2Verticals({
  verticals,
  hypotheses,
  selectedVerticalId,
  onPatchHypothesis,
  onSelectVertical,
  jobs,
  dossiers,
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

  // Готовые досье по вертикали — для строки цифр на карточке.
  const readyDossierByVertical = useMemo(() => {
    const map = new Map<string, HeDossier>();
    for (const d of dossiers ?? []) {
      if (d.status === 'ready' && d.data) map.set(d.vertical_id, d);
    }
    return map;
  }, [dossiers]);

  // Фильтр-чипы над доской и набор свёрнутых карточек (по умолчанию все развёрнуты).
  const [filter, setFilter] = useState<HypothesisFilter>('all');
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 p-10 text-center">
        <p className="text-sm font-medium text-gray-500">Вертикалей пока нет</p>
        <p className="mt-1 text-xs text-gray-400">
          Дождитесь окончания исследования — направления появятся здесь.
        </p>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <p className="text-sm text-gray-600 xl:col-span-2">
        Движок нашёл {sorted.length} {pluralDirections(sorted.length)}. Выберите одно — под него соберём письма,
        вокабуляр и шаблон.
      </p>

      {/* Фильтр гипотез внутри карточек + свёртка всех карточек разом */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 xl:col-span-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Фильтр гипотез">
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              aria-pressed={filter === chip.id}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                filter === chip.id
                  ? 'border-blue-200 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-700'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCollapsedIds(new Set(sorted.map((v) => v.id)))}
            className="text-xs font-medium text-gray-500 transition hover:text-gray-700"
          >
            Свернуть все
          </button>
          <button
            type="button"
            onClick={() => setCollapsedIds(new Set())}
            className="text-xs font-medium text-gray-500 transition hover:text-gray-700"
          >
            Развернуть все
          </button>
        </div>
      </div>

      {sorted.map((vertical) => (
        <VerticalCard
          key={vertical.id}
          vertical={vertical}
          hypotheses={hypothesesByVertical.get(vertical.id) ?? []}
          filter={filter}
          collapsed={collapsedIds.has(vertical.id)}
          onToggleCollapsed={() => toggleCollapsed(vertical.id)}
          selected={vertical.id === selectedVerticalId}
          buildNote={vertical.id === selectedVerticalId && buildActive}
          dossier={readyDossierByVertical.get(vertical.id) ?? null}
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
  filter,
  collapsed,
  onToggleCollapsed,
  selected,
  buildNote,
  dossier,
  onSelectVertical,
  onPatchHypothesis,
}: {
  vertical: HeVertical;
  hypotheses: HeHypothesis[];
  filter: HypothesisFilter;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selected: boolean;
  buildNote: boolean;
  dossier: HeDossier | null;
  onSelectVertical: (id: string) => void;
  onPatchHypothesis: (id: string, status: HypothesisPatchStatus) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  // Какое массовое действие сейчас выполняется (спиннер на группе кнопок).
  const [busyAction, setBusyAction] = useState<HypothesisPatchStatus | null>(null);

  const total = hypotheses.length;
  const acceptedCount = hypotheses.filter((h) => h.status === 'accepted').length;
  const visibleHypotheses =
    filter === 'all' ? hypotheses : hypotheses.filter((h) => matchesFilter(h, filter));

  // Массовая разметка всех гипотез вертикали — последовательно, чтобы не гнать
  // десятки PATCH параллельно; ошибки показывает родитель (actionError).
  const applyToAll = async (status: HypothesisPatchStatus) => {
    if (status === 'rejected') {
      const confirmed = window.confirm(`Отклонить все гипотезы направления «${vertical.name}»?`);
      if (!confirmed) return;
    }
    const targets = hypotheses.filter((h) => h.status !== status);
    if (targets.length === 0) return;
    setBusyAction(status);
    try {
      for (const h of targets) {
        await onPatchHypothesis(h.id, status);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const busy = busyAction !== null;

  return (
    <article
      className={`rounded-2xl border p-5 shadow-sm transition ${
        selected ? 'border-emerald-300 bg-white ring-1 ring-emerald-500/40' : 'border-gray-200 bg-white'
      }`}
    >
      {/* Шапка: свёртка, rank, название, потенциал, массовые действия */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Развернуть карточку' : 'Свернуть карточку'}
          className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            aria-hidden
          />
        </button>
        {vertical.rank != null ? (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[11px] font-bold text-gray-500">
            {vertical.rank}
          </span>
        ) : null}
        <h3 className="text-base font-semibold text-gray-900">{vertical.name}</h3>
        <PotentialBadge pct={vertical.potential_pct} />
        {selected ? <Badge tone="emerald">Выбрано</Badge> : null}
        {collapsed && total > 0 ? (
          <span className="text-xs text-gray-400">
            {total} {pluralHypotheses(total)} · {acceptedCount}/{total} принято
          </span>
        ) : null}
        {!collapsed && total > 0 ? (
          <div
            className="ml-auto flex items-center gap-0.5"
            role="group"
            aria-label="Массовые действия с гипотезами"
          >
            {busy ? <Spinner className="mr-1 h-3.5 w-3.5 text-gray-400" /> : null}
            <button
              type="button"
              onClick={() => void applyToAll('accepted')}
              disabled={busy || acceptedCount === total}
              title="Принять все гипотезы направления"
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-400 transition hover:bg-emerald-50 hover:text-emerald-600 disabled:pointer-events-none disabled:opacity-40"
            >
              принять все
            </button>
            <button
              type="button"
              onClick={() => void applyToAll('rejected')}
              disabled={busy || hypotheses.every((h) => h.status === 'rejected')}
              title="Отклонить все гипотезы направления"
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:pointer-events-none disabled:opacity-40"
            >
              отклонить все
            </button>
            <button
              type="button"
              onClick={() => void applyToAll('proposed')}
              disabled={busy || hypotheses.every((h) => h.status === 'proposed')}
              title="Сбросить разметку всех гипотез направления"
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:pointer-events-none disabled:opacity-40"
            >
              сбросить
            </button>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        <>
          {vertical.summary ? (
            <p className={`mt-2 text-sm leading-relaxed text-gray-600 ${showDetails ? '' : 'line-clamp-2'}`}>
              {vertical.summary}
            </p>
          ) : null}

          {/* Цифры готового досье — компактная строка под саммари */}
          {dossier ? <DossierStatRow dossier={dossier} /> : null}

          {/* Синонимы — за «Подробнее», чтобы не шуметь */}
          {vertical.synonyms.length > 0 ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
                className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-700"
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
                    <span key={syn} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
                      {syn}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Гипотезы вертикали (список фильтруется чипами над доской) */}
          {total > 0 ? (
            <details className="group mt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-800">
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden />
                Гипотезы ({filter === 'all' ? total : `${visibleHypotheses.length} из ${total}`})
                <span className="text-xs font-normal text-gray-400">
                  · принято {acceptedCount} / {total}
                </span>
              </summary>
              {visibleHypotheses.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {visibleHypotheses.map((h) => (
                    <HypothesisItem key={h.id} hypothesis={h} onPatch={onPatchHypothesis} />
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-gray-400">Под этот фильтр здесь ничего не попадает.</p>
              )}
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
                  ? 'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-5 text-sm font-medium text-emerald-700'
                  : 'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700'
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
              <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-gray-400">
                <Spinner className="h-3 w-3" />
                Собираем письма, вокабуляр и шаблон…
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </article>
  );
}

/* ─────────────────────────── Гипотеза ─────────────────────────── */

/**
 * fit_rationale приезжает в he_hypotheses отдельной интеграцией — тип
 * HeHypothesis ей не владеет, поэтому читаем поле структурно (как
 * audience_side в dossier.ts). Легаси-строки без поля рендерятся как раньше.
 */
function fitRationaleOf(h: HeHypothesis): string | null {
  const raw = (h as HeHypothesis & { fit_rationale?: unknown }).fit_rationale;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

/** Компактная строка цифр досье: «~N компаний · M вакансий hh · reply X% vs Y%» (null-safe). */
function DossierStatRow({ dossier }: { dossier: HeDossier }) {
  const data = dossier.data;
  if (!data) return null;
  const parts: string[] = [];
  if (data.counters.companies_total != null) {
    parts.push(`~${data.counters.companies_total.toLocaleString('ru-RU')} компаний`);
  }
  if (data.counters.hh_vacancies_total != null) {
    parts.push(`${data.counters.hh_vacancies_total.toLocaleString('ru-RU')} вакансий hh`);
  }
  if (data.dataset_stats.reply_pct != null) {
    parts.push(
      data.dataset_stats.baseline_pct != null
        ? `reply ${data.dataset_stats.reply_pct}% vs ${data.dataset_stats.baseline_pct}%`
        : `reply ${data.dataset_stats.reply_pct}%`,
    );
  }
  if (parts.length === 0) return null;
  return <p className="mt-2 text-xs font-medium text-gray-500">{parts.join(' · ')}</p>;
}

function HypothesisItem({
  hypothesis,
  onPatch,
}: {
  hypothesis: HeHypothesis;
  onPatch: (id: string, status: HypothesisPatchStatus) => void;
}) {
  const rejected = hypothesis.status === 'rejected';
  const accepted = hypothesis.status === 'accepted';
  const fitRationale = fitRationaleOf(hypothesis);

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
          {fitRationale ? (
            <div className="mt-2 rounded-md border-l-2 border-blue-400 bg-blue-50/50 px-3 py-2">
              <p className="text-[11px] font-semibold text-blue-600">Почему это рынок:</p>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-700">{fitRationale}</p>
            </div>
          ) : null}
          {hypothesis.description ? (
            <p className="mt-1 text-sm leading-relaxed text-gray-600">{hypothesis.description}</p>
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
                ? 'border-emerald-300 bg-emerald-100 text-emerald-700'
                : 'border-gray-200 bg-white text-gray-400 hover:border-emerald-200 hover:text-emerald-500'
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
                ? 'border-red-300 bg-red-100 text-red-600'
                : 'border-gray-200 bg-white text-gray-400 hover:border-red-200 hover:text-red-500'
            }`}
          >
            <X className="h-4 w-4" aria-hidden />
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
