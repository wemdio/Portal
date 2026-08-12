'use client';

/**
 * Блок «Настройки прогрева» на вкладке «Прогрев».
 *
 * Свёрнут по умолчанию, пока прогрев идёт: оператор открывает вкладку, чтобы
 * смотреть, а не настраивать, и экран без того плотный. Внутри две секции —
 * переписка между своими и активность в публичных чатах; список чатов лежит во
 * второй, рядом с числами, которые им управляют.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { ChevronDown, ChevronRight, Loader2, Save } from 'lucide-react';
import type { CampaignStatus } from '@/lib/tgOutreach/types';
import {
  FIELD_BOUNDS,
  curveToPerDay,
  perDayForEditing,
  type WarmupParamKey,
  type WarmupSettings,
} from '@/lib/tgOutreach/warmup/settings';
import WarmupChatsSection from './WarmupChatsSection';
import WarmupDayTable from './WarmupDayTable';

const API_BASE = '/api/tools/tg-outreach';

const PARAM_LABEL: Record<WarmupParamKey, string> = {
  conversations: 'Переписок в день на аккаунт',
  messages: 'Сообщений в одной переписке',
  chat_messages: 'Сообщений в день на аккаунт',
  chat_reactions: 'Реакций в день на аккаунт',
};

/** Пара полей «первый день → потолок» одного параметра. */
function CurveRow({
  paramKey,
  first,
  peak,
  disabled,
  onChange,
}: {
  paramKey: WarmupParamKey;
  first: number;
  peak: number;
  disabled: boolean;
  onChange: (field: 'first' | 'peak', value: number) => void;
}) {
  const bounds = FIELD_BOUNDS[paramKey];
  const input = (field: 'first' | 'peak', value: number) => (
    <input
      type="number"
      min={bounds.min}
      max={bounds.max}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(field, Number(e.target.value))}
      className="w-14 rounded-lg border border-gray-200 bg-gray-50 px-1.5 py-1 text-center text-[11px] text-gray-800 outline-none focus:border-indigo-400 disabled:opacity-40"
    />
  );
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-gray-600">{PARAM_LABEL[paramKey]}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {input('first', first)}
        <span className="text-[11px] text-gray-400">→</span>
        {input('peak', peak)}
      </span>
    </div>
  );
}

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
  const [draft, setDraft] = useState<WarmupSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  /** Предпросмотр кривой: без него «2 → 8» ничего не говорит про среду. */
  const preview = useMemo(() => curveToPerDay(draft, Math.min(days, 7)), [draft, days]);

  const tableRows = useMemo(() => perDayForEditing(draft, days), [draft, days]);

  const setCurve = (key: WarmupParamKey, field: 'first' | 'peak', value: number) => {
    setDraft((d) => ({
      ...d,
      curve: { ...d.curve, [key]: { ...d.curve[key], [field]: value } },
    }));
  };

  const setCell = (dayIndex: number, key: WarmupParamKey, value: number) => {
    setDraft((d) => {
      const rows = perDayForEditing(d, days);
      rows[dayIndex] = { ...rows[dayIndex], [key]: value };
      return { ...d, per_day: rows };
    });
  };

  /**
   * Включение ручного режима фиксирует текущую кривую в таблице: правят потом
   * пару клеток, а не заполняют двадцать полей с нуля.
   */
  const toggleManual = (manual: boolean) => {
    setDraft((d) => ({
      ...d,
      mode: manual ? 'manual' : 'curve',
      per_day: manual && !d.per_day.length ? perDayForEditing(d, days) : d.per_day,
    }));
  };

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Не получилось сохранить');
        return;
      }
      // Забираем то, что сервер реально записал: он мог зажать число в границы,
      // и без этой строки панель осталась бы «не сохранено» навсегда.
      if (data.settings) setDraft(data.settings as WarmupSettings);
      setNotice(
        data.applies_next_day
          ? 'Сохранено. План сегодняшнего дня уже составлен — новые числа вступят со следующего.'
          : 'Сохранено. Применится при следующем запуске прогрева.',
      );
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [campaignId, draft, onSaved]);

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
          {dirty && <span className="text-[10px] font-normal text-amber-600">не сохранено</span>}
        </span>
        <span className="text-[11px] text-gray-400">
          {draft.mode === 'manual' ? 'по дням вручную' : 'разгон по кривой'} · дней: {days}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">Между своими</p>
            <CurveRow
              paramKey="conversations"
              first={draft.curve.conversations.first}
              peak={draft.curve.conversations.peak}
              disabled={draft.mode === 'manual'}
              onChange={(f, v) => setCurve('conversations', f, v)}
            />
            <CurveRow
              paramKey="messages"
              first={draft.curve.messages.first}
              peak={draft.curve.messages.peak}
              disabled={draft.mode === 'manual'}
              onChange={(f, v) => setCurve('messages', f, v)}
            />
            {draft.mode === 'curve' && (
              <p className="mt-1 text-[10px] text-gray-400">
                {preview
                  .map((r, i) => `день ${i + 1} · ${r.conversations}×${r.messages}`)
                  .join('  →  ')}
              </p>
            )}
          </div>

          <div className="border-t border-gray-100 pt-3">
            <label className="mb-1 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={chatsEnabled}
                onChange={(e) => setDraft((d) => ({ ...d, public_chats: e.target.checked }))}
                className="h-3.5 w-3.5 accent-indigo-600"
              />
              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                В публичных чатах
              </span>
            </label>

            {chatsEnabled && (
              <>
                <CurveRow
                  paramKey="chat_messages"
                  first={draft.curve.chat_messages.first}
                  peak={draft.curve.chat_messages.peak}
                  disabled={draft.mode === 'manual'}
                  onChange={(f, v) => setCurve('chat_messages', f, v)}
                />
                <CurveRow
                  paramKey="chat_reactions"
                  first={draft.curve.chat_reactions.first}
                  peak={draft.curve.chat_reactions.peak}
                  disabled={draft.mode === 'manual'}
                  onChange={(f, v) => setCurve('chat_reactions', f, v)}
                />
                <div className="flex items-center justify-between gap-3 py-1">
                  <span className="text-[11px] text-gray-600">Чатов на аккаунт</span>
                  <input
                    type="number"
                    min={FIELD_BOUNDS.chats_per_account.min}
                    max={FIELD_BOUNDS.chats_per_account.max}
                    value={draft.chats_per_account}
                    onChange={(e) => setDraft((d) => ({ ...d, chats_per_account: Number(e.target.value) }))}
                    className="w-14 rounded-lg border border-gray-200 bg-gray-50 px-1.5 py-1 text-center text-[11px] text-gray-800 outline-none focus:border-indigo-400"
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

          <div className="border-t border-gray-100 pt-3">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-gray-600">
              <input
                type="checkbox"
                checked={draft.mode === 'manual'}
                onChange={(e) => toggleManual(e.target.checked)}
                className="h-3.5 w-3.5 accent-indigo-600"
              />
              Задать по дням вручную
            </label>
            {draft.mode === 'manual' && (
              <div className="mt-2">
                <WarmupDayTable
                  rows={tableRows}
                  currentDay={currentDay}
                  chatsEnabled={chatsEnabled}
                  disabled={false}
                  onChange={setCell}
                />
                <p className="mt-1.5 text-[10px] text-gray-400">
                  Пока галочка стоит, поля выше не действуют. Снимете — вернётся разгон по кривой,
                  а таблица сохранится до следующего включения.
                </p>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">{error}</div>
          )}
          {notice && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[11px] text-gray-600">{notice}</div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => setDraft(settings)}
              className="rounded-lg px-3 py-1.5 text-[11px] text-gray-500 transition hover:bg-gray-50 disabled:opacity-40"
            >
              Отменить
            </button>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Сохранить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
