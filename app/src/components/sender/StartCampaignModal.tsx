'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { CalendarClock, Loader2, Play } from 'lucide-react';
import { zonedParts, zonedTimeToUtc } from '@/lib/sender/sendWindow';
import type { CampaignDto } from './api';
import { timezoneLabel, weekdaysLabel } from './CampaignSteps';
import { SenderModal } from './SenderModal';

const pad = (n: number) => String(n).padStart(2, '0');

/** «UTC+3» для пояса кампании; не вышло — пусто. */
function utcOffsetLabel(timezone: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return part ? part.replace('GMT', 'UTC') : '';
  } catch {
    return '';
  }
}

/** Пояс кампании с отступом от UTC: «Moscow (UTC+3)». */
export function zoneCaption(timezone: string, at = new Date()): string {
  const offset = utcOffsetLabel(timezone, at);
  return offset ? `${timezoneLabel(timezone)} (${offset})` : timezoneLabel(timezone);
}

/** Момент запуска по поясу кампании: «3 окт., 10:00». */
export function formatInZone(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Завтра в начале окна отправки по поясу кампании — значения полей по умолчанию. */
function defaultSlot(campaign: CampaignDto): { date: string; time: string } {
  const tomorrow = zonedParts(new Date(Date.now() + 24 * 3600_000), campaign.timezone);
  return {
    date: `${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}`,
    time: `${pad(campaign.send_hour_from)}:00`,
  };
}

function parseSlot(date: string, time: string, timezone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  return zonedTimeToUtc(
    { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]), hour: Number(t[1]), minute: Number(t[2]) },
    timezone,
  );
}

/**
 * Окно «Запустить» / «Продолжить»: сразу или в выбранное время. Время вводится
 * по часовому поясу кампании (её окно отправки живёт в нём же); запускает
 * кампанию воркер «Рассылки», когда время наступит.
 */
export function StartCampaignModal({
  campaign,
  onClose,
  onStartNow,
  onSchedule,
}: {
  campaign: CampaignDto;
  onClose: () => void;
  onStartNow: () => Promise<void>;
  onSchedule: (startAtIso: string) => Promise<void>;
}) {
  const resume = campaign.status === 'paused';
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const initial = useMemo(() => defaultSlot(campaign), [campaign]);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Момент открытия окна: рендер должен быть чистым, а точную проверку
  // «время прошло» всё равно делает сервер.
  const [openedAt] = useState(() => Date.now());
  const tz = campaign.timezone;
  const nowThere = zonedParts(new Date(openedAt), tz);
  const startAt = mode === 'later' ? parseSlot(date, time, tz) : null;
  const tooEarly = startAt ? startAt.getTime() <= openedAt + 60_000 : false;
  // Вне окна отправки кампания запустится, но письма пойдут с ближайшего окна.
  const outsideWindow = startAt
    ? (() => {
        const p = zonedParts(startAt, tz);
        return p.hour < campaign.send_hour_from || p.hour >= campaign.send_hour_to || !(campaign.send_weekdays ?? []).includes(p.weekday);
      })()
    : false;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const submit = async () => {
    setError(null);
    if (mode === 'later' && (!startAt || tooEarly)) {
      setError(startAt ? 'Это время уже прошло — выберите позже' : 'Укажите дату и время');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'now') await onStartNow();
      else await onSchedule((startAt as Date).toISOString());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось');
    } finally {
      setBusy(false);
    }
  };

  const option = (value: 'now' | 'later', icon: ReactNode, title: string, hint: string) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      className={`flex flex-1 items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        mode === value ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-zinc-200 hover:bg-zinc-50'
      }`}
    >
      <span className="mt-0.5 text-zinc-600">{icon}</span>
      <span>
        <span className="block text-sm font-medium text-zinc-900">{title}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
    </button>
  );

  return (
    <SenderModal
      title={resume ? 'Продолжить кампанию' : 'Запустить кампанию'}
      subtitle={`«${campaign.name}»`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-3.5 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {mode === 'now' ? (resume ? 'Продолжить сейчас' : 'Запустить сейчас') : 'Отложить запуск'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          {option('now', <Play className="h-4 w-4" />, 'Сразу', 'Письма пойдут в ближайшее окно отправки')}
          {option('later', <CalendarClock className="h-4 w-4" />, 'Отложить', 'Кампания запустится сама в выбранное время')}
        </div>

        {mode === 'later' ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-zinc-600">
                Дата
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="mt-1 block rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900"
                />
              </label>
              <label className="text-xs text-zinc-600">
                Время
                <input
                  type="time"
                  step={300}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="mt-1 block rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900"
                />
              </label>
            </div>
            <p className="text-xs text-zinc-500">
              Часовой пояс кампании: <span className="font-medium text-zinc-700">{zoneCaption(tz)}</span>, сейчас там{' '}
              {pad(nowThere.hour)}:{pad(nowThere.minute)}.
            </p>
            {startAt && !tooEarly ? (
              <p className="text-sm text-zinc-800">
                Запуск: {formatInZone(startAt.toISOString(), tz)} по поясу {timezoneLabel(tz)}
                {browserZone && browserZone !== tz ? ` (у вас ${formatInZone(startAt.toISOString(), browserZone)})` : ''}.
              </p>
            ) : null}
            {tooEarly ? <p className="text-xs text-red-600">Это время уже прошло.</p> : null}
            {outsideWindow && !tooEarly ? (
              <p className="text-xs text-amber-600">
                Вне окна отправки ({campaign.send_hour_from}:00–{campaign.send_hour_to}:00, {weekdaysLabel(campaign.send_weekdays ?? [])}) —
                письма пойдут с ближайшего окна.
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    </SenderModal>
  );
}
