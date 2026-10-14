'use client';

/**
 * Пометка «рынок снят с ежедневного добора» и её кнопка «Resume daily top-up»
 * (POST /api/client/eng/verticals/[id]/refill) — на карточке рынка шага 3
 * «Launch». Прежняя доска гипотез шага 2 с Accept/Reject отсюда убрана: рынки
 * теперь выбирает шаг 2 «Choose markets» (EngStepMarkets) целиком.
 */

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { HeVertical } from '@/lib/hypothesisEngine/types';
import { EngPaidAccessError, resumeEngVerticalRefill } from './api-client';
import { EngPaidAccessNotice } from './EngPaidAccess';
import { EngSpinner } from './ui';

/**
 * Пометка «вертикаль снята с ежедневного добора»: ночной проход увидел N подряд
 * прогонов, не добавивших ни одного контакта (lib/hypothesisEngine/autoPipeline.ts).
 *
 * ФОРМА ДАННЫХ РАЗБИРАЕТСЯ ЦЕЛИКОМ, а не по счастливому случаю. Пометку ставит
 * одна запись сразу двумя полями, но экран обязан пережить любую строку,
 * которая до него доедет (старая запись, правка руками, будущий писатель):
 *   * штампа нет / он пустой → пометки НЕТ, карточка молчит. Штамп —
 *     единственный признак: именно по нему правило решает, выдавать ли слот;
 *   * штамп есть, число ночей меньше единицы (нет ключа, null, ноль, дробь
 *     вроде 0.5 — всё это после округления вниз даёт 0) → фраза БЕЗ числа:
 *     «0 daily top-ups in a row» было бы ложью о причине. Дробь БОЛЬШЕ
 *     единицы округляется вниз и печатается (1.7 → «1 daily top-up»): такое
 *     число занижает серию, но не выдумывает её;
 *   * штамп есть, но не парсится как дата → фраза без даты, пометка остаётся.
 * Ни в одной ветке текст не обещает того, чего не знает.
 *
 * Про окно рассинхрона честно: правило выключается флагом окружения ВОРКЕРА, и
 * пометки, оставшиеся от включённого периода, снимает ночной проход — разом по
 * всему проекту, до цикла по вертикалям, потому что до вертикали за пределами
 * ночного бюджета цикл может и не дойти. Но ночной проход берёт только проекты
 * с ВКЛЮЧЁННЫМ конфигом добора (autoPipeline.loadConfigs: enabled = true).
 * Отсюда два окна:
 *   * конфиг включён — до первого прохода, то есть максимум одна ночь,
 *     карточка может показывать паузу, которой уже нет;
 *   * конфиг выключен или его нет — пометка не снимается вовсе, пока клиент
 *     не нажмёт «Resume daily top-up» или конфиг снова не включат. Ложью фраза
 *     от этого не становится: ночного добора у такого проекта нет целиком, а
 *     кнопка пометку снимает.
 * Проверять флаг здесь нельзя: у кабинета и у воркера разные процессы и
 * разное окружение, и прочитанный здесь флаг отвечал бы за чужую машину.
 */
function refillPauseNote(vertical: HeVertical): { headline: string; since: string } | null {
  const since = typeof vertical.refill_dry_since === 'string' ? vertical.refill_dry_since.trim() : '';
  if (!since) return null;
  const raw = vertical.refill_dry_nights;
  const nights = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  const headline =
    nights >= 1
      ? `The daily top-up is paused for this market — ${nights} daily top-up${nights === 1 ? '' : 's'} in a row brought no new contacts.`
      : 'The daily top-up is paused for this market — its recent daily top-ups brought no new contacts.';
  const parsed = Date.parse(since);
  const stamp = Number.isNaN(parsed)
    ? ''
    : new Date(parsed).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return { headline, since: stamp };
}

/**
 * Карточка паузы добора рынка с кнопкой, которая её отменяет: причина, дата и
 * кнопка — в одном месте. Цвет нейтральный, а не красный: ничего не сломалось и
 * ничего не потеряно. Пометки нет и рынок не возвращали этим экраном —
 * ничего не рисуется.
 */
export function EngRefillPauseNote({ vertical, onChanged }: { vertical: HeVertical; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [error, setError] = useState('');
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);
  const pause = refillPauseNote(vertical);

  const onResume = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setRefusal(null);
    try {
      await resumeEngVerticalRefill(vertical.id);
      setResumed(true);
      onChanged();
    } catch (e) {
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else setError(e instanceof Error ? e.message : 'Failed to resume the daily top-up for this market');
    } finally {
      setBusy(false);
    }
  };

  // Подтверждение держится до перезагрузки деталки: пометка уже снята, и без
  // этой строки нажатие выглядело бы как «ничего не произошло».
  if (!pause) {
    return resumed ? (
      <p className="mt-2 text-xs" style={{ color: 'var(--cp-green)' }}>
        Daily top-up resumed — this market is eligible for the daily top-up again.
      </p>
    ) : null;
  }
  return (
    <div className="mt-2 rounded-md p-3 flex flex-col gap-2" style={{ border: '1px solid var(--cp-divider)' }}>
      <p className="text-xs m-0" style={{ color: 'var(--cp-text-m)' }}>
        {pause.headline}
        {pause.since ? ` Paused on ${pause.since}.` : ''} Only the daily collection for this market stopped — the
        campaign and everything already in it are untouched.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onResume()}
          disabled={busy}
          className="ds-btn-secondary inline-flex items-center gap-1 text-[11px]"
          title="Put this market back into the daily top-up"
        >
          {busy ? <EngSpinner className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
          Resume daily top-up
        </button>
        <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          It becomes eligible for the daily top-up again.
        </span>
      </div>
      {refusal && <EngPaidAccessNotice refusal={refusal} />}
      {error && (
        <span className="text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
