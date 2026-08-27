'use client';

/**
 * Шаг 2 мастера «Движка вертикалей» — выбор направления.
 * Карточки по rank: название, потенциал, короткое саммари; синонимы спрятаны
 * за «Подробнее», гипотезы с доказательствами — в раскрываемом блоке
 * (accept/reject как в старой доске, оптимистично через onPatchHypothesis).
 * Главное действие карточки — «Выбрать это направление →» (onSelectVertical).
 * Чтобы разметка десятков гипотез не утомляла: над доской фильтр-чипы и
 * «Свернуть/развернуть все», на карточке — тихий текст-коллапс до одной строки и
 * тихие массовые действия «принять все / отклонить все / сбросить».
 * Под саммари — тихая строка «что уже собрано» по вертикали (цепочка, вокабуляр,
 * досье, база, шаблон); у гипотез, под которые собрана база, — метка «база».
 * Визуал — токены design.ts: без иконок, статусы точками, один синий акцент.
 */

import { useMemo, useState, type JSX } from 'react';
import type {
  VeHypothesis,
  VeHypothesisTier,
  VeStage,
  VeTemplate,
  VeVertical,
  VeVocab,
} from '@/lib/verticalEngineV2/types';
import { TIER_META } from '../ui';
import { HE, Spinner, StatusDot } from '../design';
import type {
  VeBaseSummary,
  VeChainDto,
  VeDossier,
  VeJobSummary,
  VeProjectDetailResponse,
} from '../api';

/** Стадии досборки материалов под выбранную вертикаль (письма/вокабуляр/шаблон). */
const BUILD_STAGES: ReadonlySet<VeStage> = new Set(['chain', 'vocab', 'template']);

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

function matchesFilter(h: VeHypothesis, filter: HypothesisFilter): boolean {
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

/** Текстовая метка тира (T1/T2/T3) вместо бейджа; подсказка — в title. */
function TierText({ tier }: { tier: VeHypothesisTier }) {
  const meta = TIER_META[tier] ?? TIER_META[3];
  return (
    <span title={meta.hint} className={HE.tierText}>
      {meta.label}
    </span>
  );
}

/** Пилюля процента потенциала: ≥50 изумрудная, ≥25 янтарная, <25 серая. */
function PctPill({ pct }: { pct: number }) {
  const tone =
    pct >= 50
      ? 'bg-emerald-100 text-emerald-700'
      : pct >= 25
        ? 'bg-amber-100 text-amber-700'
        : 'bg-gray-100 text-gray-500';
  return (
    <span
      className={`${HE.pill} ${tone}`}
      title="Потенциал сегмента (0–100) — оценка привлекательности сегмента как рынка для аутрича. Это не прогноз reply%."
    >
      {pct}%
    </span>
  );
}

export interface Step2VerticalsProps {
  verticals: VeProjectDetailResponse['verticals'];
  hypotheses: VeProjectDetailResponse['hypotheses'];
  selectedVerticalId: string | null;
  onPatchHypothesis: (id: string, status: HypothesisPatchStatus) => void;
  onSelectVertical: (id: string) => void;
  jobs: VeJobSummary[];
  /** Досье вертикалей (для компактной строки цифр на готовых). */
  dossiers?: VeDossier[];
  /** Цепочки писем — для строки «что собрано» на карточке вертикали. */
  chains?: VeChainDto[];
  /** Вокабуляры вертикалей. */
  vocabs?: VeVocab[];
  /** Базы контактов: счётчик/строки в строке артефактов и метки «база» у гипотез. */
  bases?: VeBaseSummary[];
  /** Шаблоны писем (готовность относится на вертикаль через base_id). */
  templates?: VeTemplate[];
}

export function Step2Verticals({
  verticals,
  hypotheses,
  selectedVerticalId,
  onPatchHypothesis,
  onSelectVertical,
  jobs,
  dossiers,
  chains,
  vocabs,
  bases,
  templates,
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
    const map = new Map<string, VeHypothesis[]>();
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
  // Досье приходят created_at desc: первое готовое и есть новейшее.
  const readyDossierByVertical = useMemo(() => {
    const map = new Map<string, VeDossier>();
    for (const d of dossiers ?? []) {
      if (d.status === 'ready' && d.data && !map.has(d.vertical_id)) map.set(d.vertical_id, d);
    }
    return map;
  }, [dossiers]);

  // Последняя готовая цепочка по вертикали — для строки «что собрано».
  const readyChainByVertical = useMemo(() => {
    const map = new Map<string, VeChainDto>();
    for (const c of chains ?? []) {
      if (c.status !== 'ready') continue;
      const prev = map.get(c.vertical_id);
      if (!prev || c.created_at > prev.created_at) map.set(c.vertical_id, c);
    }
    return map;
  }, [chains]);

  // В типе VeVocab поля status нет (в таблице он есть, API отдаёт select('*')),
  // поэтому читаем структурно — как fitRationaleOf.
  const readyVocabVerticals = useMemo(() => {
    const set = new Set<string>();
    for (const v of vocabs ?? []) {
      if ((v as VeVocab & { status?: unknown }).status === 'ready') set.add(v.vertical_id);
    }
    return set;
  }, [vocabs]);

  const basesByVertical = useMemo(() => {
    const map = new Map<string, VeBaseSummary[]>();
    for (const b of bases ?? []) {
      const list = map.get(b.vertical_id) ?? [];
      list.push(b);
      map.set(b.vertical_id, list);
    }
    return map;
  }, [bases]);

  // Шаблон привязан к базе (base_id) и вертикали — у него есть свой vertical_id.
  const readyTemplateVerticals = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates ?? []) {
      if (t.status === 'ready' && t.vertical_id) set.add(t.vertical_id);
    }
    return set;
  }, [templates]);

  // Гипотезы, под которые собрана база. Источники (base-per-hypothesis):
  // 1) колонка ve_bases.hypothesis_id (новый путь «база на гипотезу»);
  // 2) collect_info.hypothesis_id (ед., снапшот в стадии);
  // 3) collect_info.hypothesis_ids (мн., легаси-сборка по вертикали).
  // У старых баз поля нет — они просто ничего не помечают. Фейловые базы не
  // считаем: маркер «база» на гипотезе должен совпадать со статистикой карточки.
  const baseHypothesisIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of bases ?? []) {
      if (b.status === 'failed') continue;
      const colId = (b as { hypothesis_id?: string | null }).hypothesis_id;
      if (typeof colId === 'string' && colId.length > 0) set.add(colId);
      const info = b.collect_info as { hypothesis_id?: unknown; hypothesis_ids?: unknown } | null | undefined;
      if (typeof info?.hypothesis_id === 'string' && info.hypothesis_id.length > 0) {
        set.add(info.hypothesis_id);
      }
      if (Array.isArray(info?.hypothesis_ids)) {
        for (const id of info.hypothesis_ids) {
          if (typeof id === 'string') set.add(id);
        }
      }
    }
    return set;
  }, [bases]);

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
      <div className={HE.emptyState}>
        <p className="text-sm font-medium text-gray-500">Вертикалей пока нет</p>
        <p className={`mt-1 text-xs ${HE.muted}`}>
          Дождитесь окончания исследования — направления появятся здесь.
        </p>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <p className={`xl:col-span-2 ${HE.lead}`}>
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
              className={`${HE.btnSmall} ${
                filter === chip.id ? 'border-blue-600! text-blue-600!' : ''
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
            className={HE.btnQuiet}
          >
            Свернуть все
          </button>
          <button type="button" onClick={() => setCollapsedIds(new Set())} className={HE.btnQuiet}>
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
          chain={readyChainByVertical.get(vertical.id) ?? null}
          vocabReady={readyVocabVerticals.has(vertical.id)}
          bases={basesByVertical.get(vertical.id) ?? []}
          templateReady={readyTemplateVerticals.has(vertical.id)}
          baseHypothesisIds={baseHypothesisIds}
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
  chain,
  vocabReady,
  bases,
  templateReady,
  baseHypothesisIds,
  onSelectVertical,
  onPatchHypothesis,
}: {
  vertical: VeVertical;
  hypotheses: VeHypothesis[];
  filter: HypothesisFilter;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selected: boolean;
  buildNote: boolean;
  dossier: VeDossier | null;
  /** Последняя готовая цепочка вертикали (null — цепочки ещё нет). */
  chain: VeChainDto | null;
  vocabReady: boolean;
  bases: VeBaseSummary[];
  templateReady: boolean;
  /** Id гипотез, под которые собрана база (из collect_info всех баз проекта). */
  baseHypothesisIds: ReadonlySet<string>;
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
  // Длинное саммари режется line-clamp-2: тогда «Подробнее» нужно даже без
  // синонимов — иначе хвост описания недоступен вовсе.
  const summaryLong = (vertical.summary?.length ?? 0) > 160;

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
    <article className={`${HE.card} p-5 transition ${selected ? 'border-blue-500! ring-1 ring-blue-500/40' : ''}`}>
      {/* Шапка: rank, название, потенциал, выбор, массовые действия, свёртка */}
      <div className="flex flex-wrap items-center gap-2">
        {vertical.rank != null ? <span className={HE.rankNum}>{vertical.rank}</span> : null}
        <h3 className="text-[15px] font-semibold text-gray-900">{vertical.name}</h3>
        <PctPill pct={vertical.potential_pct} />
        {typeof vertical.actual_reply_pct === 'number' ? (
          <span
            className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
            title="Фактический reply rate запущенных кампаний вертикали (сверка прогноза с реальностью)"
          >
            факт reply {vertical.actual_reply_pct}%{vertical.actual_sent ? ` · ${vertical.actual_sent.toLocaleString('ru-RU')} отправок` : ''}
          </span>
        ) : null}
        {selected ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <StatusDot tone="ok" />
            Выбрано
          </span>
        ) : null}
        {collapsed && total > 0 ? (
          <span className={`text-xs ${HE.muted}`}>
            {total} {pluralHypotheses(total)} · {acceptedCount}/{total} принято
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {!collapsed && total > 0 ? (
            <div className="flex items-center gap-1.5" role="group" aria-label="Массовые действия с гипотезами">
              {busy ? <Spinner className="mr-0.5 h-3.5 w-3.5" /> : null}
              <button
                type="button"
                onClick={() => void applyToAll('accepted')}
                disabled={busy || acceptedCount === total}
                title="Принять все гипотезы направления"
                className={HE.btnSmall}
              >
                принять все
              </button>
              <button
                type="button"
                onClick={() => void applyToAll('rejected')}
                disabled={busy || hypotheses.every((h) => h.status === 'rejected')}
                title="Отклонить все гипотезы направления"
                className={HE.btnSmall}
              >
                отклонить все
              </button>
              <button
                type="button"
                onClick={() => void applyToAll('proposed')}
                disabled={busy || hypotheses.every((h) => h.status === 'proposed')}
                title="Сбросить разметку всех гипотез направления"
                className={HE.btnSmall}
              >
                сбросить
              </button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? 'Развернуть карточку' : 'Свернуть карточку'}
            className={HE.btnQuiet}
          >
            {collapsed ? 'Развернуть' : 'Свернуть'}
          </button>
        </div>
      </div>

      {!collapsed ? (
        <>
          {vertical.summary ? (
            <p className={`mt-2 text-[13px] leading-relaxed text-gray-600 ${showDetails ? '' : 'line-clamp-2'}`}>
              {vertical.summary}
            </p>
          ) : null}

          {/* Цифры готового досье — компактная строка под саммари */}
          {dossier ? <DossierStatRow dossier={dossier} /> : null}

          {/* Что уже собрано по вертикали: цепочка/вокабуляр/досье/база/шаблон */}
          <ArtifactStatRow
            chain={chain}
            vocabReady={vocabReady}
            dossierReady={dossier !== null}
            bases={bases}
            templateReady={templateReady}
          />

          {/* Синонимы — за «Подробнее», чтобы не шуметь */}
          {vertical.synonyms.length > 0 || summaryLong ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
                className={HE.btnQuiet}
              >
                {showDetails ? 'Скрыть' : 'Подробнее'}
              </button>
              {showDetails && vertical.synonyms.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {vertical.synonyms.map((syn) => (
                    <span key={syn} className={HE.chip}>
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
              <summary className={`cursor-pointer list-none ${HE.btnQuiet}`}>
                Гипотезы ({filter === 'all' ? total : `${visibleHypotheses.length} из ${total}`})
                <span className={`text-xs ${HE.muted}`}> · принято {acceptedCount} / {total}</span>
              </summary>
              {visibleHypotheses.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {visibleHypotheses.map((h) => (
                    <HypothesisItem
                      key={h.id}
                      hypothesis={h}
                      onPatch={onPatchHypothesis}
                      hasBase={baseHypothesisIds.has(h.id)}
                    />
                  ))}
                </ul>
              ) : (
                <p className={`mt-2 text-xs ${HE.muted}`}>Под этот фильтр здесь ничего не попадает.</p>
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
                  ? `inline-flex h-11 w-full items-center justify-center gap-2 px-5 text-sm font-medium text-emerald-700 ${HE.successPanel}`
                  : `w-full ${HE.btnPrimary}`
              }
            >
              {selected ? (
                <>
                  <StatusDot tone="ok" />
                  Выбрано
                </>
              ) : (
                'Выбрать это направление →'
              )}
            </button>
            {buildNote ? (
              <p className={`mt-2 flex items-center justify-center gap-1.5 text-xs ${HE.muted}`}>
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
 * fit_rationale приезжает в ve_hypotheses отдельной интеграцией — тип
 * VeHypothesis ей не владеет, поэтому читаем поле структурно (как
 * audience_side в dossier.ts). Легаси-строки без поля рендерятся как раньше.
 */
function fitRationaleOf(h: VeHypothesis): string | null {
  const raw = (h as VeHypothesis & { fit_rationale?: unknown }).fit_rationale;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

/** Компактная строка цифр досье: «~N компаний · M вакансий hh · reply X% vs Y%» (null-safe). */
function DossierStatRow({ dossier }: { dossier: VeDossier }) {
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
  return <p className={`mt-2 text-xs tabular-nums ${HE.muted2}`}>{parts.join(' · ')}</p>;
}

/**
 * Тихая строка «что уже собрано» по вертикали: цепочка, вокабуляр, досье, база,
 * шаблон. Собранное — gray-700, несобранное — gray-300; маркер «база» прячется,
 * когда баз нет совсем. Разделитель « · » — как в DossierStatRow, без иконок.
 */
function ArtifactStatRow({
  chain,
  vocabReady,
  dossierReady,
  bases,
  templateReady,
}: {
  chain: VeChainDto | null;
  vocabReady: boolean;
  dossierReady: boolean;
  bases: VeBaseSummary[];
  templateReady: boolean;
}) {
  const markers: Array<{ key: string; label: string; ready: boolean }> = [
    {
      key: 'chain',
      label: chain && chain.language !== 'ru' ? `цепочка (${chain.language})` : 'цепочка',
      ready: chain !== null,
    },
    { key: 'vocab', label: 'вокабуляр', ready: vocabReady },
    { key: 'dossier', label: 'досье', ready: dossierReady },
  ];
  if (bases.length > 0) {
    // Считаем базу артефактом только когда она разобрана (analyzed):
    // collecting/uploaded/analyzing — это процесс, не результат.
    const usable = bases.filter((b) => b.status === 'analyzed');
    const rows = usable.reduce((sum, b) => sum + (b.row_count ?? 0), 0);
    if (usable.length > 0) {
      markers.push({
        key: 'base',
        label: rows > 0 ? `база ${usable.length} · ${rows.toLocaleString('ru-RU')}` : `база ${usable.length}`,
        ready: true,
      });
    }
  }
  markers.push({ key: 'template', label: 'шаблон', ready: templateReady });
  return (
    <p className={`mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs tabular-nums ${HE.muted2}`}>
      {markers.map((m, i) => (
        <span key={m.key} className={`whitespace-nowrap ${m.ready ? 'text-gray-700' : 'text-gray-300'}`}>
          {i > 0 ? (
            <span aria-hidden="true" className="text-gray-300">
              ·{' '}
            </span>
          ) : null}
          {m.label}
        </span>
      ))}
    </p>
  );
}

function HypothesisItem({
  hypothesis,
  onPatch,
  hasBase,
}: {
  hypothesis: VeHypothesis;
  onPatch: (id: string, status: HypothesisPatchStatus) => void;
  /** Под гипотезу уже собрана база (collect_info.hypothesis_ids). */
  hasBase?: boolean;
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
            <TierText tier={hypothesis.tier} />
            <p className="text-sm font-semibold text-gray-900">{hypothesis.title}</p>
            <PctPill pct={hypothesis.potential_pct} />
            {hasBase ? (
              <span title="Под эту гипотезу собрана база" className="text-[11px] font-medium text-blue-600">
                база
              </span>
            ) : null}
          </div>
          {fitRationale ? (
            <p className="mt-2 rounded-lg bg-blue-50/60 px-3 py-2 text-[12.5px] leading-relaxed text-gray-700">
              <strong className="font-semibold text-gray-900">Почему это рынок:</strong> {fitRationale}
            </p>
          ) : null}
          {hypothesis.description ? (
            <p className="mt-1 text-sm leading-relaxed text-gray-600">{hypothesis.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => onPatch(hypothesis.id, accepted ? 'proposed' : 'accepted')}
            title={accepted ? 'Снять принятие' : 'Принять гипотезу'}
            aria-pressed={accepted}
            className={
              accepted
                ? '-mx-2 -my-1 rounded-md px-2 py-1 text-xs font-semibold text-emerald-600 underline decoration-emerald-300 underline-offset-4 transition hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300'
                : '-mx-2 -my-1 rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300'
            }
          >
            {accepted ? 'Принято' : 'Принять'}
          </button>
          <button
            type="button"
            onClick={() => onPatch(hypothesis.id, rejected ? 'proposed' : 'rejected')}
            title={rejected ? 'Вернуть в предложенные' : 'Отклонить гипотезу'}
            aria-pressed={rejected}
            className={
              rejected
                ? '-mx-2 -my-1 rounded-md px-2 py-1 text-xs font-semibold text-red-500 transition hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300'
                : '-mx-2 -my-1 rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300'
            }
          >
            {rejected ? 'Отклонено' : 'Отклонить'}
          </button>
        </div>
      </div>

      {hypothesis.evidence.length > 0 ? (
        <details className="mt-2">
          <summary className={`cursor-pointer list-none ${HE.btnQuiet}`}>
            Доказательства ({hypothesis.evidence.length})
          </summary>
          <ul className="mt-2 space-y-2 border-l-2 border-gray-100 pl-3">
            {hypothesis.evidence.map((ev, ei) => (
              <li key={ei} className="text-xs leading-relaxed">
                <p className="italic text-gray-500">«{ev.quote}»</p>
                <p className="mt-0.5 text-gray-500">{ev.claim}</p>
                <a
                  href={ev.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-block break-all text-blue-600 transition hover:text-blue-700 hover:underline"
                >
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
