'use client';

/**
 * Блок «Настройки прогрева» на вкладке «Прогрев».
 *
 * Свёрнут по умолчанию, пока прогрев идёт: оператор открывает вкладку, чтобы
 * смотреть, а не настраивать, и экран без того плотный. Внутри две секции —
 * переписка между своими и активность в публичных чатах; список чатов лежит во
 * второй, рядом с числами, которые им управляют.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { CampaignStatus } from '@/lib/tgOutreach/types';
import {
  FIELD_BOUNDS,
  perDayForEditing,
  type WarmupSettings,
} from '@/lib/tgOutreach/warmup/settings';
import WarmupChatsSection from './WarmupChatsSection';
import { NumField } from './NumField';
import WarmupDayTable from './WarmupDayTable';

const API_BASE = '/api/tools/tg-outreach';

export default function WarmupSettingsPanel({
  campaignId,
  campaignStatus,
  settings,
  days,
  currentDay,
  runActive,
  onSaved,
}: {
  campaignId: string;
  campaignStatus: CampaignStatus;
  settings: WarmupSettings;
  /** Сколько дней выбрано в полосе управления — столько строк в таблице. */
  days: number;
  /** Идущий день прогрева или null. */
  currentDay: number | null;
  runActive: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(!runActive);
  // Режим всегда «по дням вручную»: старая кривая разгона один раз переносится в
  // таблицу, дальше правятся только её клетки.
  const [draft, setDraft] = useState<WarmupSettings>(() => (
    settings.mode === 'manual' && settings.per_day.length
      ? settings
      : { ...settings, mode: 'manual', per_day: perDayForEditing(settings, days) }
  ));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Автосохранение (22.10.2026): правка уходит на сервер через 0,8 с сама, кнопки
  // «Сохранить» нет. lastSaved — то, что сервер уже знает: по нему отличаем
  // правку оператора от обновления настроек сверху.
  const lastSaved = useRef(JSON.stringify(settings));
  const draftKey = JSON.stringify(draft);
  const dirty = draftKey !== lastSaved.current;

  const tableRows = useMemo(() => perDayForEditing(draft, days), [draft, days]);

  const setCell = (dayIndex: number, key: WarmupParamKey, value: number) => {
    setDraft((d) => {
      const rows = perDayForEditing(d, days);
      rows[dayIndex] = { ...rows[dayIndex], [key]: value };
      return { ...d, per_day: rows };
    });
  };

  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; });

  const save = useCallback(async () => {
    const sent = draftRef.current;
    const sentKey = JSON.stringify(sent);
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: sent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Отправленное считаем «известным», иначе автосохранение зациклилось бы
        // на отказе; следующая правка снимет ошибку и уйдёт снова.
        lastSaved.current = sentKey;
        setError(data.error ?? 'Не получилось сохранить');
        return;
      }
      // Забираем то, что сервер реально записал: он мог зажать число в границы.
      const saved = (data.settings ?? sent) as WarmupSettings;
      lastSaved.current = JSON.stringify(saved);
      if (JSON.stringify(draftRef.current) === sentKey) setDraft(saved);
      setNotice(
        data.applies_next_day
          ? 'Сохранено. План сегодняшнего дня уже составлен — новые числа вступят со следующего.'
          : 'Сохранено. Применится при следующем запуске прогрева.',
      );
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [campaignId, onSaved]);

  useEffect(() => {
    if (draftKey === lastSaved.current) return;
    setNotice(null);
    const timer = setTimeout(() => { void save(); }, 800);
    return () => clearTimeout(timer);
  }, [draftKey, save]);

  // Настройки пришли сверху (загрузка, другой оператор): подхватываем, если
  // у нас нет несохранённой правки.
  useEffect(() => {
    const incoming = JSON.stringify(settings);
    if (JSON.stringify(draftRef.current) === lastSaved.current) setDraft(settings);
    lastSaved.current = incoming;
  }, [settings]);

  const chatsEnabled = draft.public_chats;

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Настройки прогрева
          {saving ? <Loader2 className="h-3 w-3 animate-spin text-gray-400" /> : dirty ? <span className="text-[10px] font-normal text-amber-600">сохраняю…</span> : null}
        </span>
        <span className="text-[11px] text-gray-400">
          по дням · дней: {days}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          {/* Нагрузка задаётся по дням вручную: кривая разгона убрана 22.10.2026,
              таблица — единственный режим. Число дней берётся из полосы
              управления выше. */}
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wide text-gray-400">Нагрузка по дням</p>
            <WarmupDayTable
              rows={tableRows}
              currentDay={currentDay}
              chatsEnabled={chatsEnabled}
              disabled={false}
              onChange={setCell}
            />
          </div>

          {/* Публичные чаты используют редко — поэтому ниже и под переключателем. */}
          <div className="border-t border-gray-100 pt-3">
            <label className="mb-1 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={chatsEnabled}
                onChange={(e) => setDraft((d) => ({ ...d, public_chats: e.target.checked }))}
                className="tg-check"
              />
              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                В публичных чатах
              </span>
            </label>

            {chatsEnabled && (
              <>
                <div className="flex items-center justify-between gap-3 py-1">
                  <span className="text-[11px] text-gray-600">Чатов на аккаунт</span>
                  <NumField
                    min={FIELD_BOUNDS.chats_per_account.min}
                    max={FIELD_BOUNDS.chats_per_account.max}
                    value={draft.chats_per_account}
                    onChange={(v) => setDraft((d) => ({ ...d, chats_per_account: v }))}
                    className="w-14 rounded-lg border border-gray-300/70 bg-white/50 px-1.5 py-1 text-center text-[11px] text-gray-800 outline-none focus:border-indigo-400"
                  />
                </div>
                <div className="mt-2">
                  <WarmupChatsSection
                    campaignId={campaignId}
                    campaignStatus={campaignStatus}
                    onChanged={onSaved}
                  />
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">{error}</div>
          )}
          {notice && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[11px] text-gray-600">{notice}</div>
          )}

          <div className="flex items-center justify-end gap-1.5 border-t border-gray-100 pt-2 text-[11px] text-gray-400">
            {saving ? (
              <><Loader2 className="h-3 w-3 animate-spin" />Сохраняю…</>
            ) : dirty ? (
              'Изменения сохранятся сами'
            ) : (
              <><Check className="h-3 w-3 text-emerald-500" />Все изменения сохранены</>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
