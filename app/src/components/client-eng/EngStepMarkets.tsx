'use client';

/**
 * Шаг 2 «Choose markets» клиентского ENG-кабинета: карточка с галочкой на
 * каждый рынок (вертикаль исследования) в порядке rank, значок «Recommended»
 * у рекомендованных, одна строка «почему этот рынок» и раскрывашка «Details» с
 * идеями покупателей (гипотезы рынка: заголовок и описание — без тиров, без
 * оценок и без Accept/Reject). Внизу — «N markets selected» и «Continue»:
 * PUT /api/client/eng/projects/[id]/markets с отмеченными рынками, затем шаг 3.
 *
 * Правило выбора одно на экран и сервер (lib/hypothesisEngine/engMarkets):
 *  - у свежего проекта (ни одна гипотеза не принята и не отклонена) галочки
 *    стоят на рекомендованных — клиенту достаточно нажать «Continue»;
 *  - дальше галочки — выбранные рынки (есть принятая гипотеза);
 *  - рынок, по которому работа уже началась, отмечен и заперт («In
 *    progress»): роут снятие такого рынка откажет (409 market_started).
 * «Accept recommended» ставит галочки ровно на рекомендованные (плюс
 * запертые — их снять нельзя).
 *
 * Пока клиент не трогал галочки, экран показывает значения сервера (полл их
 * обновляет); после первой правки — свой черновик до сохранения.
 */

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Lock } from 'lucide-react';
import type { HeHypothesis, HeProjectStatus, HeVertical } from '@/lib/hypothesisEngine/types';
import {
  heEngMarketStarted,
  heEngMarketWhy,
  heEngMarketsFresh,
  heEngRecommendedVerticalIds,
  heEngSelectedVerticalIds,
} from '@/lib/hypothesisEngine/engMarkets';
import { saveEngMarkets } from './api-client';
import { EngSupportText } from './EngPaidAccess';
import { EngBadge, EngCard, EngSpinner } from './ui';
import type { EngDetail } from './EngProjectWizard';

/**
 * Почему рынков на шаге 2 ещё нет — по КАЖДОМУ статусу проекта, с тем, что
 * делать: рынки появляются только у законченного исследования, а что с ним,
 * говорит шаг 1. `never` в конце заставит компилятор потребовать текст для
 * нового статуса.
 */
function notResearchedText(status: Exclude<HeProjectStatus, 'researched'>): string {
  switch (status) {
    case 'draft':
      return 'Your markets appear here once the research of your business is finished, and it is not running on this project — step 1 «Your business» says what to do.';
    case 'researching':
      return 'Your markets appear here as soon as the research of your business finishes — step 1 «Your business» shows how far it has got.';
    case 'failed':
      return 'The research of your business stopped before it found your markets — step 1 «Your business» shows what happened and whether it can be tried again.';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Рынки в порядке rank (1 — лучший); без rank — в конце, по имени. */
function byRank(a: HeVertical, b: HeVertical): number {
  const ra = typeof a.rank === 'number' ? a.rank : Number.POSITIVE_INFINITY;
  const rb = typeof b.rank === 'number' ? b.rank : Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  return a.name.localeCompare(b.name);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Карточка рынка: галочка, имя, значки, строка «почему» и «Details». */
function MarketCard({
  vertical,
  ideas,
  why,
  checked,
  recommended,
  locked,
  disabled,
  onToggle,
}: {
  vertical: HeVertical;
  ideas: HeHypothesis[];
  why: string | null;
  checked: boolean;
  recommended: boolean;
  locked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const inputId = `eng-market-${vertical.id}`;
  return (
    <div
      className="ds-card p-4 flex flex-col gap-2"
      style={checked ? { borderColor: 'var(--cp-paper-mute)' } : undefined}
    >
      <div className="flex items-start gap-3">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled || locked}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer disabled:cursor-not-allowed"
          aria-describedby={why ? `${inputId}-why` : undefined}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={inputId} className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
              {vertical.name}
            </label>
            {recommended && <EngBadge label="Recommended" tone="green" />}
            {locked && (
              <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                <Lock className="h-3 w-3" /> In progress
              </span>
            )}
          </div>
          {why && (
            <p id={`${inputId}-why`} className="m-0 text-xs" style={{ color: 'var(--cp-text-m)' }}>
              {why}
            </p>
          )}
          {ideas.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 self-start text-[11px] hover:underline"
              style={{ color: 'var(--cp-text-l)' }}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Details
            </button>
          )}
          {open && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {ideas.map((h) => (
                <li key={h.id} className="rounded-md p-3" style={{ border: '1px solid var(--cp-divider)' }}>
                  <div className="text-xs font-semibold" style={{ color: 'var(--cp-paper)' }}>
                    {h.title}
                  </div>
                  {h.description && (
                    <p className="m-0 mt-1 whitespace-pre-wrap text-xs" style={{ color: 'var(--cp-text-m)' }}>
                      {h.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function EngStepMarkets({
  detail,
  onChanged,
  goToStep,
}: {
  detail: EngDetail;
  /** Перечитать деталку; «Continue» ждёт его, чтобы шаг 3 открылся со свежими рынками. */
  onChanged: () => Promise<void> | void;
  goToStep: (step: number) => void;
}) {
  const verticals = useMemo(() => [...((detail.verticals ?? []) as HeVertical[])].sort(byRank), [detail]);
  const hypotheses = useMemo(() => (detail.hypotheses ?? []) as HeHypothesis[], [detail]);
  const status = detail.project.status;

  const fresh = heEngMarketsFresh(hypotheses);
  const recommended = useMemo(() => heEngRecommendedVerticalIds(verticals, hypotheses), [verticals, hypotheses]);
  const serverSelected = useMemo(() => {
    const known = new Set(verticals.map((v) => v.id));
    return heEngSelectedVerticalIds(hypotheses).filter((id) => known.has(id));
  }, [verticals, hypotheses]);
  /** Рынки, по которым работа началась: отмечены и заперты. */
  const locked = useMemo(() => {
    const activeJobs = (detail.jobs ?? []).filter((j) => j.status === 'pending' || j.status === 'running');
    const state = {
      chains: detail.chains ?? [],
      bases: detail.bases ?? [],
      templates: detail.templates ?? [],
      activeJobs,
    };
    return new Set(verticals.filter((v) => heEngMarketStarted(v.id, state)).map((v) => v.id));
  }, [detail, verticals]);

  // Галочки сервера: свежий проект — рекомендованные, иначе выбранные; запертые
  // отмечены всегда.
  const serverTicked = useMemo(() => {
    const base = fresh ? recommended : serverSelected;
    return [...new Set([...base, ...locked])];
  }, [fresh, recommended, serverSelected, locked]);

  /** Черновик клиента; null — галочки не трогали, на экране значения сервера. */
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (status !== 'researched') {
    return (
      <EngCard>
        <p className="m-0 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          {notResearchedText(status)}
        </p>
        <button
          type="button"
          onClick={() => goToStep(1)}
          className="ds-btn-secondary mt-3 inline-flex items-center gap-1.5 text-xs"
        >
          <ArrowLeft className="h-3 w-3" /> Your business
        </button>
      </EngCard>
    );
  }

  if (verticals.length === 0) {
    return (
      <EngCard>
        <p className="m-0 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          <EngSupportText text="The research finished, but it did not find any markets for this website. Message Support." />
        </p>
      </EngCard>
    );
  }

  const known = new Set(verticals.map((v) => v.id));
  const ticked = (draft ?? serverTicked).filter((id) => known.has(id));
  const tickedSet = new Set(ticked);
  const recommendedTicks = [...new Set([...recommended, ...locked])];
  const showAcceptRecommended = recommended.length > 0 && !sameSet(ticked, recommendedTicks);

  const toggle = (id: string) => {
    if (locked.has(id) || saving) return;
    setError('');
    setDraft(tickedSet.has(id) ? ticked.filter((x) => x !== id) : [...ticked, id]);
  };

  /**
   * Сохранение нужно, когда набор отличается от выбранного на сервере, и у
   * свежего проекта всегда: там галочки стоят по рекомендации, а на сервере не
   * выбран ни один рынок. Иначе «Continue» просто ведёт на шаг 3.
   */
  const onContinue = async () => {
    if (saving || ticked.length === 0) return;
    if (!fresh && sameSet(ticked, serverSelected)) {
      setDraft(null);
      goToStep(3);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await saveEngMarkets(detail.project.id, ticked);
      await onChanged();
      setDraft(null);
      goToStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save your markets');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <EngCard>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
            <h3 className="ds-eyebrow m-0">Choose markets</h3>
            <p className="m-0 text-xs" style={{ color: 'var(--cp-text-m)' }}>
              {recommended.length > 0
                ? `These are the markets the research found for your business. We marked ${
                    recommended.length === 1 ? 'the one' : `the ${recommended.length}`
                  } with the best fit for your offer as «Recommended». Tick the ones to start with and press «Continue».`
                : 'These are the markets the research found for your business. Tick the ones to start with and press «Continue».'}
            </p>
            {/* После «Launch» отмеченный рынок сам не стартует (решение
                владельца по умолчанию) — сказать до того, как клиент его
                отметит. */}
            {/* Под паузой потолка расхода «Launch» его не начнёт (реконсилер
                встаёт на потолке) — к кнопке не зовём (как шаг 3). */}
            {(locked.size > 0 || detail.auto_launch?.requested === true) && (
              <p className="m-0 text-xs" style={{ color: 'var(--cp-paper)' }}>
                {detail.project.autopilot_hold?.code === 'spend_paused'
                  ? 'A market you tick now does not start by itself. Work on this project is paused on our side; our team has been notified.'
                  : 'A market you tick now starts when you press «Launch» on step 3 again — markets ticked after a launch do not start by themselves.'}
              </p>
            )}
          </div>
          {showAcceptRecommended && (
            <button
              type="button"
              onClick={() => {
                setError('');
                setDraft(recommendedTicks);
              }}
              disabled={saving}
              className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs"
            >
              Accept recommended
            </button>
          )}
        </div>
      </EngCard>

      <div className="flex flex-col gap-3">
        {verticals.map((v) => {
          const own = hypotheses.filter((h) => h.vertical_id === v.id);
          const live = own.filter((h) => h.status !== 'rejected');
          return (
            <MarketCard
              key={v.id}
              vertical={v}
              ideas={live.length > 0 ? live : own}
              why={heEngMarketWhy(v, hypotheses)}
              checked={tickedSet.has(v.id)}
              recommended={recommended.includes(v.id)}
              locked={locked.has(v.id)}
              disabled={saving}
              onToggle={() => toggle(v.id)}
            />
          );
        })}
      </div>

      <div
        className="ds-card sticky bottom-3 z-10 flex flex-wrap items-center gap-3 p-3"
        style={{ background: 'var(--cp-surface-elev)' }}
      >
        <span className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
          {ticked.length === 1 ? '1 market selected' : `${ticked.length} markets selected`}
          {ticked.length === 0 ? ' — tick at least one to continue' : ''}
        </span>
        <button
          type="button"
          onClick={() => void onContinue()}
          disabled={saving || ticked.length === 0}
          className="ds-btn-primary ml-auto inline-flex items-center gap-1.5 text-xs"
        >
          {saving ? <EngSpinner className="h-3 w-3" /> : null}
          Continue <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          <EngSupportText text={error} />
        </div>
      )}
    </div>
  );
}
