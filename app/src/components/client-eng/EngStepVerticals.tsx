'use client';

/**
 * Шаг 2 «Verticals»: доска вертикалей с гипотезами. Кнопки Accept/Reject
 * размечают гипотезы (PATCH /api/client/eng/hypotheses/[id], % и rank
 * вертикалей пересчитываются на бэкенде). Accepted-гипотезы — основа
 * авто-сборки базы на шаге 4.
 */

import { useMemo, useState } from 'react';
import { Check, Rocket, X } from 'lucide-react';
import type { HeHypothesis, HeProjectStatus, HeVertical } from '@/lib/hypothesisEngine/types';
import { patchEngHypothesis, startEngAutopilot } from './api-client';
import { EngBadge, EngCard, EngSpinner, hypothesisStatusTone } from './ui';
import type { EngDetail } from './EngProjectWizard';

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1 · obvious',
  2: 'Tier 2 · adjacent',
  3: 'Tier 3 · non-obvious',
};

function HypothesisCard({
  hypothesis,
  busy,
  onVerdict,
}: {
  hypothesis: HeHypothesis;
  busy: boolean;
  onVerdict: (id: string, verdict: 'accept' | 'reject') => void;
}) {
  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2"
      style={{ border: '1px solid var(--cp-divider)' }}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
          {hypothesis.title}
        </span>
        <EngBadge label={TIER_LABELS[hypothesis.tier] ?? `Tier ${hypothesis.tier}`} tone="neutral" />
        <span className="ml-auto ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
          {hypothesis.potential_pct}%
        </span>
        <EngBadge label={hypothesis.status} tone={hypothesisStatusTone(hypothesis.status)} />
      </div>
      {hypothesis.description && (
        <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--cp-text-m)' }}>
          {hypothesis.description}
        </p>
      )}
      {hypothesis.fit_rationale && (
        <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--cp-text-l)' }}>
          {hypothesis.fit_rationale}
        </p>
      )}
      {hypothesis.status === 'proposed' && (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => onVerdict(hypothesis.id, 'accept')}
            disabled={busy}
            className="ds-btn-secondary inline-flex items-center gap-1 text-[11px]"
          >
            {busy ? <EngSpinner className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            Accept
          </button>
          <button
            type="button"
            onClick={() => onVerdict(hypothesis.id, 'reject')}
            disabled={busy}
            className="ds-btn-ghost inline-flex items-center gap-1 text-[11px]"
          >
            <X className="h-3 w-3" />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Почему кнопки «Start outreach» нет — по КАЖДОМУ статусу проекта.
 *
 * Без этой подсказки шаг 2 — тупик: кнопка просто исчезает, и клиент видит
 * доску без единого следующего шага. У каждой ветки поэтому названо ДЕЙСТВИЕ,
 * которое в кабинете действительно есть: вердикты над гипотезами здесь же либо
 * «Re-run research» на шаге 1. Выдуманных сроков нет — когда закончится
 * исследование, экран не знает.
 *
 * ВЕТКИ ИСЧЕРПЫВАЮЩИЕ, и это не аккуратность ради аккуратности: `switch` по
 * `HeProjectStatus` с `never` в конце заставит компилятор потребовать текст для
 * пятого статуса, если он появится, — вместо того чтобы молча отдать его чужой
 * ветке. Ровно это и случилось с 'draft': он был склеен с 'researching' в
 * «opens as soon as the research finishes», хотя отмена всех задач
 * (`cancel`-роут) возвращает проект именно в 'draft', и ждать там нечего —
 * research не идёт и сам не начнётся. Обещание «как только закончится» в этом
 * состоянии было ложью, а волна 5 сделала её несущей: обе новые карточки
 * автопилота отправляют клиента ровно в эту фразу.
 *
 * Порядок внутри `switch` роли не играет (ветки по значению), но статус
 * проверяется РАНЬШЕ числа принятых гипотез: 'researched' — единственный
 * статус, в котором кнопку блокирует именно отсутствие вердикта, и совет
 * «примите гипотезу» на недоисследованном проекте не помог бы
 * (`canStartOutreach` требует и того, и другого).
 */
function startOutreachHintFor(status: HeProjectStatus): string {
  switch (status) {
    case 'draft':
      return 'The research is not running on this project — open step 1 and press «Re-run research» to start it. «Start outreach» opens once it finishes.';
    case 'researching':
      return '«Start outreach» opens as soon as the research finishes.';
    case 'failed':
      return '«Start outreach» opens on a researched project — step 1 shows what stopped the research and lets you run it again.';
    case 'researched':
      return 'Accept at least one hypothesis below — «Start outreach» needs one to build a base from.';
    default: {
      // Пятого статуса нет: ветка недостижима, и компилятор это проверяет.
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function EngStepVerticals({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const hypotheses = useMemo(() => (detail.hypotheses ?? []) as HeHypothesis[], [detail]);
  const jobs = useMemo(() => detail.jobs ?? [], [detail]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const [autopilotSummary, setAutopilotSummary] = useState('');
  /**
   * Нажатие ничего не поставило, потому что проект НА ПАУЗЕ (письма
   * исчерпаны, состояние не прочиталось, ремонт осиротевшей базы не удался).
   * Отдельный флаг, а не разбор текста: он решает и формулировку, и цвет —
   * зелёное «всё уже стоит или готово» на заблокированном проекте было
   * ложным успехом.
   */
  const [autopilotHeld, setAutopilotHeld] = useState(false);

  // Автопилот уже гонит конвейер, пока жива хотя бы одна его джоба.
  const AUTOPILOT_STAGES = useMemo(() => new Set(['chain', 'base_collect', 'base_analyze', 'template']), []);
  const autopilotRunning = jobs.some(
    (j) => (j.status === 'pending' || j.status === 'running') && AUTOPILOT_STAGES.has(j.stage),
  );

  const onStartOutreach = async () => {
    if (autopilotBusy || autopilotRunning) return;
    setAutopilotBusy(true);
    setError('');
    setAutopilotSummary('');
    setAutopilotHeld(false);
    try {
      const res = await startEngAutopilot(detail.project.id);
      if (res.ok) {
        const parts: string[] = [];
        if (res.chains_enqueued) parts.push(`${res.chains_enqueued} chain${res.chains_enqueued === 1 ? '' : 's'}`);
        if (res.collects_enqueued) parts.push(`${res.collects_enqueued} base collect${res.collects_enqueued === 1 ? '' : 's'}`);
        if (res.templates_enqueued) parts.push(`${res.templates_enqueued} template${res.templates_enqueued === 1 ? '' : 's'}`);
        // Вылеченная осиротевшая база — тоже ПОСТАВЛЕННАЯ стадия, а не пропуск
        // (`analyses_requeued` роут отдаёт с самого начала волны). Без этой
        // строки нажатие, доставившее пропавший анализ, отчитывалось бы «всё уже
        // стоит или готово» — то есть ровно тем же текстом, что и нажатие,
        // которое не сделало ничего.
        if (res.analyses_requeued) {
          parts.push(`${res.analyses_requeued} base analys${res.analyses_requeued === 1 ? 'is' : 'es'}`);
        }
        // Ничего не поставлено — это ДВА разных исхода. «Всё уже стоит или
        // готово» верно только там, где движок не нашёл работы; когда он её
        // нашёл, но не повёл (пауза приезжает машинным кодом
        // `autopilot_hold_code`), тот же зелёный текст был бы ложным успехом.
        // Причину не пересказываем: её полностью объясняет карточка над шагами,
        // и второй копии этого текста быть не должно.
        const held = parts.length === 0 && Boolean(res.autopilot_hold_code);
        setAutopilotHeld(held);
        setAutopilotSummary(
          parts.length > 0
            ? `Autopilot started — queued ${parts.join(' · ')}. Review & Launch fills in as stages finish.`
            : held
              ? 'Autopilot is on, but this press queued nothing — the note above the steps says what it is waiting for.'
              : 'Autopilot is on — everything is already queued or done. See Review & Launch.',
        );
      } else {
        setError(res.error ?? 'Failed to start the autopilot');
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the autopilot');
    } finally {
      setAutopilotBusy(false);
    }
  };

  const onVerdict = async (id: string, verdict: 'accept' | 'reject') => {
    if (busyId) return;
    setBusyId(id);
    setError('');
    try {
      await patchEngHypothesis(id, verdict);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the verdict');
    } finally {
      setBusyId(null);
    }
  };

  if (verticals.length === 0 && hypotheses.length === 0) {
    return (
      <EngCard>
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          {/* Та же ложь, что и в подсказке про кнопку, только на пустой доске, и
              путь сюда ЧАСТЫЙ: «Cancel all jobs» во время research возвращает
              проект в 'draft' раньше, чем появится первая гипотеза, — то есть
              клиент, сам остановивший исследование, читал «они появятся, когда
              исследование закончится». Оно не идёт и само не начнётся.
              Остальные статусы оставлены как были: там research либо идёт, либо
              его разбирает шаг 1 своей карточкой отказа. */}
          {detail.project.status === 'draft'
            ? 'No verticals yet, and no research is running — open step 1 and press «Re-run research» to start it.'
            : 'No verticals yet — they appear once the research finishes (step 1).'}
        </p>
      </EngCard>
    );
  }

  const acceptedTotal = hypotheses.filter((h) => h.status === 'accepted').length;
  // «Start outreach» — одна кнопка вместо ручного прогона каждой стадии:
  // доступна на researched-проекте с принятыми гипотезами.
  const canStartOutreach = detail.project?.status === 'researched' && acceptedTotal > 0;
  // Почему кнопки нет — исчерпывающим разбором статуса (startOutreachHintFor).
  const startOutreachHint = canStartOutreach ? '' : startOutreachHintFor(detail.project.status);
  const ungrouped = hypotheses.filter(
    (h) => !h.vertical_id || !verticals.some((v) => v.id === h.vertical_id),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
          {acceptedTotal} of {hypotheses.length} hypotheses accepted — accepted ones drive the base collection on step 4.
        </div>
        {canStartOutreach && (
          <button
            type="button"
            onClick={() => void onStartOutreach()}
            disabled={autopilotBusy || autopilotRunning}
            className="ds-btn-primary ml-auto inline-flex items-center gap-1.5 text-xs"
            title="Generate letters, collect bases and build templates for every vertical automatically"
          >
            {autopilotBusy || autopilotRunning ? <EngSpinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
            {autopilotRunning ? 'Autopilot running…' : 'Start outreach'}
          </button>
        )}
      </div>

      {startOutreachHint && (
        <div className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
          {startOutreachHint}
        </div>
      )}

      {autopilotSummary && (
        <div
          className="ds-card p-3 text-xs"
          // Зелёный закреплён за поставленной работой. Нажатие, упершееся в
          // паузу, — нейтральное: ничего не потеряно, но и успеха нет.
          style={{ color: autopilotHeld ? 'var(--cp-text-m)' : 'var(--cp-green)' }}
        >
          {autopilotSummary}
        </div>
      )}

      {verticals.map((v) => {
        const own = hypotheses.filter((h) => h.vertical_id === v.id);
        const accepted = own.filter((h) => h.status === 'accepted').length;
        return (
          <EngCard key={v.id}>
            <div className="flex items-center gap-2">
              <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                #{v.rank ?? '—'}
              </span>
              <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                {v.name}
              </h4>
              <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
                {v.potential_pct}%
              </span>
              <span className="ml-auto text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                {accepted}/{own.length} accepted
              </span>
            </div>
            {v.summary && (
              <p className="mt-1.5 text-xs whitespace-pre-wrap" style={{ color: 'var(--cp-text-m)' }}>
                {v.summary}
              </p>
            )}
            <div className="mt-3 flex flex-col gap-2">
              {own.map((h) => (
                <HypothesisCard key={h.id} hypothesis={h} busy={busyId === h.id} onVerdict={(id, verdict) => void onVerdict(id, verdict)} />
              ))}
              {own.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
                  No hypotheses linked to this vertical.
                </p>
              )}
            </div>
          </EngCard>
        );
      })}

      {ungrouped.length > 0 && (
        <EngCard>
          <h4 className="text-sm font-bold m-0 mb-3" style={{ color: 'var(--cp-paper)' }}>
            Ungrouped hypotheses
          </h4>
          <div className="flex flex-col gap-2">
            {ungrouped.map((h) => (
              <HypothesisCard key={h.id} hypothesis={h} busy={busyId === h.id} onVerdict={(id, verdict) => void onVerdict(id, verdict)} />
            ))}
          </div>
        </EngCard>
      )}

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
