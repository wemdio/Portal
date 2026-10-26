'use client';

/**
 * Где создать кампании нового запуска: Instantly (по умолчанию) или
 * «Рассылка» (этап 7, выбор специалиста). Обычная группа радиокнопок, как
 * соседние выборы запуска: выбранная «Рассылка» может стать недоступной и при
 * этом остаётся выбранной — сам экран выбор не меняет. Причина — строкой под
 * группой (aria-describedby), без title. Правила показа —
 * veLaunchTransportSwitchView (labels.ts).
 */

import { useId } from 'react';
import type { veLaunchTransportSwitchView } from '@/lib/verticalEngineV2/senderTransport/labels';
import { HE } from './design';

type SwitchView = ReturnType<typeof veLaunchTransportSwitchView>;

const CHOICES = [['instantly', 'Instantly'], ['sender', '«Рассылка»']] as const;

export function LaunchTransportSwitch({ choice, view, busy = false, onChange, onRetry }: {
  choice: 'instantly' | 'sender';
  view: SwitchView;
  /** Запрос идёт (или ответа на старт нет) — менять выбор нельзя. */
  busy?: boolean;
  onChange: (transport: 'instantly' | 'sender') => void;
  /** Не удалось проверить, доступна ли «Рассылка», — повторить проверку. */
  onRetry?: () => void;
}) {
  const id = useId();
  if (!view.show) return null;
  const noteId = `${id}-note`;
  return <fieldset className="space-y-2" aria-describedby={view.note ? noteId : undefined}>
    <legend className="ve2-label">Где создать кампании</legend>
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      {CHOICES.map(([value, label]) => (
        <label key={value} className="ve2-choice text-sm">
          <input
            type="radio"
            name={id}
            value={value}
            checked={choice === value}
            disabled={busy || (value === 'sender' && view.senderDisabled)}
            onChange={() => onChange(value)}
            className="mt-1"
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
    {view.note ? <p id={noteId} role={view.blocked ? 'alert' : undefined} className={view.blocked ? 'text-xs text-red-600' : HE.faint}>
      {view.note}
    </p> : null}
    {onRetry && (view.blocked || view.senderDisabled) ? (
      <button type="button" className={HE.btnQuiet} disabled={busy} onClick={onRetry}>Повторить проверку</button>
    ) : null}
  </fieldset>;
}
