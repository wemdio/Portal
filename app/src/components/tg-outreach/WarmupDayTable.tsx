'use client';

/**
 * Таблица «День 1…N × четыре нормы».
 *
 * Отдельный файл, потому что это единственная часть настроек с собственной
 * механикой ввода: остальное — пары полей. Строки приходят готовыми
 * (`perDayForEditing` уже дозаполнил недостающие дни кривой), компонент только
 * рисует и сообщает наверх о правках.
 */

import React from 'react';
import { FIELD_BOUNDS, type WarmupParamKey, type WarmupPerDayRow } from '@/lib/tgOutreach/warmup/settings';

const COLUMNS: Array<{ key: WarmupParamKey; label: string }> = [
  { key: 'conversations', label: 'Переписок' },
  { key: 'messages', label: 'Сообщений в переписке' },
  { key: 'chat_messages', label: 'Сообщений в чатах' },
  { key: 'chat_reactions', label: 'Реакций' },
];

export default function WarmupDayTable({
  rows,
  currentDay,
  chatsEnabled,
  disabled,
  onChange,
}: {
  rows: WarmupPerDayRow[];
  /** Идущий день прогрева — подсвечиваем и предупреждаем, что правка опоздала. */
  currentDay: number | null;
  /** Этап чатов выключен — колонки по чатам гасим, но не прячем. */
  chatsEnabled: boolean;
  disabled: boolean;
  onChange: (dayIndex: number, key: WarmupParamKey, value: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-[11px]">
        <thead>
          <tr className="text-gray-400">
            <th className="w-14 py-1 text-left font-normal">День</th>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={`py-1 text-center font-normal ${
                  !chatsEnabled && c.key.startsWith('chat_') ? 'text-gray-300' : ''
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const day = i + 1;
            const isCurrent = currentDay === day;
            const isPast = currentDay !== null && day < currentDay;
            return (
              <tr key={day} className={isCurrent ? 'bg-indigo-50' : ''}>
                <td className={`py-1 ${isCurrent ? 'text-indigo-700' : isPast ? 'text-gray-300' : 'text-gray-500'}`}>
                  {day}
                  {isCurrent && <span className="ml-1 text-[10px]">сегодня</span>}
                </td>
                {COLUMNS.map((c) => {
                  const bounds = FIELD_BOUNDS[c.key];
                  const dim = !chatsEnabled && c.key.startsWith('chat_');
                  return (
                    <td key={c.key} className="py-1 text-center">
                      <input
                        type="number"
                        min={bounds.min}
                        max={bounds.max}
                        value={row[c.key]}
                        disabled={disabled || dim}
                        title={
                          isCurrent || isPast
                            ? 'План этого дня уже составлен — правка вступит со следующего'
                            : undefined
                        }
                        onChange={(e) => onChange(i, c.key, Number(e.target.value))}
                        className={`w-14 rounded-lg border px-1.5 py-1 text-center text-[11px] outline-none focus:border-indigo-400 disabled:opacity-40 ${
                          isCurrent ? 'border-indigo-300 bg-white' : 'border-gray-200 bg-gray-50'
                        } ${isPast ? 'text-gray-400' : 'text-gray-800'}`}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
