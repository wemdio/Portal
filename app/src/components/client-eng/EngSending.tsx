'use client';

/**
 * Отправка запуска шаблона (вертикали) в кабинете: тег настоящего статуса,
 * строка «Sending · N emails sent · M replies» и кнопка Pause / Start sending /
 * Resume, а рядом с Pause — вторая «Start the rest», когда часть кампаний
 * отправляет, а часть стоит, или рядом со «Start sending» — вторая «Pause»,
 * когда клиент просил отправку, а всё стоит (`secondary_action`). Один компонент на Command Center (сводка приходит в агрегате
 * дашборда, `summary`) и на карточку рынка шага 3 «Launch» (`poll`: компонент читает
 * GET /eng/templates/[id]/sending сам, раз в 30 с в видимой вкладке).
 *
 * Сводку и тексты делает сервер и engText (engSendingLine / engSendingNote /
 * engSendingActionText): компонент ничего не выводит сам. После нажатия
 * показывает итог и свежую сводку из ответа; следующий опрос её заменяет.
 */

import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import {
  EngPaidAccessError,
  fetchEngTemplateSending,
  postEngTemplateSending,
  type HeEngSendingAction,
  type HeEngSendingSecondaryAction,
  type HeEngSendingSummary,
} from './api-client';
import {
  engSendingActionLabel,
  engSendingActionText,
  engSendingLine,
  engSendingNote,
  engSendingTag,
} from './engText';
import { EngPaidAccessNotice, EngSupportText } from './EngPaidAccess';
import { EngBadge, EngSpinner } from './ui';

const POLL_MS = 30_000;

export function EngSendingBlock({
  templateId,
  summary: external,
  poll = false,
  onChanged,
}: {
  templateId: string;
  /** Сводка из агрегата дашборда; undefined — компонент читает её сам (`poll`). */
  summary?: HeEngSendingSummary | null;
  poll?: boolean;
  /** После нажатия — перечитать родителя (дашборд). */
  onChanged?: () => void;
}) {
  const [summary, setSummary] = useState<HeEngSendingSummary | null>(external ?? null);
  const [busy, setBusy] = useState<HeEngSendingAction | HeEngSendingSecondaryAction | null>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);

  useEffect(() => {
    if (external !== undefined) setSummary(external);
  }, [external]);

  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchEngTemplateSending(templateId);
        if (!cancelled) setSummary(next);
      } catch {
        // Сбой опроса — остаётся последняя прочитанная сводка.
      }
    };
    void load();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [poll, templateId]);

  if (!summary) return null;

  const tag = engSendingTag(summary);
  const note = engSendingNote(summary);

  // «Start the rest» — тот же старт: отправляющие кампании он не трогает.
  const act = async (action: HeEngSendingAction | HeEngSendingSecondaryAction) => {
    if (busy) return;
    setBusy(action);
    setResult(null);
    setRefusal(null);
    try {
      const res = await postEngTemplateSending(templateId, action === 'pause' ? 'pause' : 'start');
      if (res.sending) setSummary(res.sending);
      const text = engSendingActionText(res.action, res.result, res.sending);
      const failed =
        'paused' in res.result
          ? res.result.failed + res.result.not_attempted > 0 || res.result.state_recorded === false
          : res.result.failed.length + res.result.not_attempted > 0 ||
            res.result.started - res.result.compensated + res.result.already_sending + (res.result.unconfirmed ?? 0) === 0;
      setResult(text ? { tone: failed ? 'error' : 'ok', text } : null);
      onChanged?.();
    } catch (e) {
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else setResult({ tone: 'error', text: e instanceof Error ? e.message : 'The request did not go through.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <EngBadge label={tag.label} tone={tag.tone} />
        <span className="text-[11px] ds-mono" style={{ color: 'var(--cp-paper-mute)' }}>
          {engSendingLine(summary)}
        </span>
        {summary.action && (
          <button
            type="button"
            onClick={() => void act(summary.action as HeEngSendingAction)}
            disabled={busy !== null}
            className={`${summary.action === 'pause' ? 'ds-btn-secondary' : 'ds-btn-primary'} ml-auto inline-flex items-center gap-1.5 text-xs`}
          >
            {busy === summary.action ? (
              <EngSpinner className="h-3 w-3" />
            ) : summary.action === 'pause' ? (
              <Pause className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {engSendingActionLabel(summary.action)}
          </button>
        )}
        {summary.secondary_action && (
          <button
            type="button"
            onClick={() => void act(summary.secondary_action as HeEngSendingSecondaryAction)}
            disabled={busy !== null}
            className={`${summary.secondary_action === 'pause' ? 'ds-btn-secondary' : 'ds-btn-primary'} ${
              summary.action ? '' : 'ml-auto '
            }inline-flex items-center gap-1.5 text-xs`}
          >
            {busy === summary.secondary_action ? (
              <EngSpinner className="h-3 w-3" />
            ) : summary.secondary_action === 'pause' ? (
              <Pause className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {engSendingActionLabel(summary.secondary_action)}
          </button>
        )}
      </div>
      {note && (
        <p className="text-[11px] m-0" style={{ color: summary.state === 'attention' ? 'var(--cp-red)' : 'var(--cp-amber)' }}>
          <EngSupportText text={note} />
        </p>
      )}
      {result && (
        <p className="text-[11px] m-0" style={{ color: result.tone === 'ok' ? 'var(--cp-paper-mute)' : 'var(--cp-amber)' }}>
          <EngSupportText text={result.text} />
        </p>
      )}
      {refusal && <EngPaidAccessNotice refusal={refusal} />}
    </div>
  );
}
