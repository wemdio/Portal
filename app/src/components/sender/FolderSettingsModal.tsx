'use client';

import { useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { updateFolder, type SenderFolderDto } from './api';
import { ScheduleStep, Step } from './CampaignSteps';
import { MailboxPickerModal, type PickedMailbox } from './MailboxPickerModal';
import { SenderModal } from './SenderModal';

/** Сколько адресов показываем в строке выбора до того, как перейти на «и ещё N». */
const SHOWN_MAILBOXES = 4;
/** Писем после первого: цепочка обоих автоаутричей — четыре письма. */
const FOLLOW_UPS = 3;
/** Задержка письма, если в папке её нет: день, как в сидах папок. */
const DEFAULT_DELAY_HOURS = 24;
const MAX_DELAY_DAYS = 30;
const MAX_GAP_SECONDS = 3600;

/**
 * Частые пояса папок: Россия, Великобритания, восток и запад США. Остальные
 * вписываются руками — список всех поясов мира в выпадашке никто не листает.
 */
const COMMON_TIMEZONES = [
  { id: 'Europe/Moscow', label: 'Москва' },
  { id: 'Europe/London', label: 'Лондон' },
  { id: 'America/New_York', label: 'Нью-Йорк' },
  { id: 'America/Los_Angeles', label: 'Лос-Анджелес' },
];
const CUSTOM_TIMEZONE = 'custom';

/** Пояс, который понимает браузер. Сервер проверяет тем же Intl и приводит написание. */
function isKnownTimezone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    return Boolean(new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone);
  } catch {
    return false;
  }
}

function isWorking(mailbox: PickedMailbox): boolean {
  return mailbox.status === 'verified' && mailbox.enabled === true;
}

function delaysOf(folder: SenderFolderDto): number[] {
  return Array.from({ length: FOLLOW_UPS }, (_, index) => {
    const hours = Number(folder.step_delays_hours[index]);
    return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_DELAY_HOURS;
  });
}

/** Дни для поля ввода: числовое поле понимает только точку — 36 ч это «1.5». */
function daysValue(hours: number): string {
  return String(Math.round((hours / 24) * 10) / 10);
}

/** Дни для подписи — по-русски, с запятой. */
function daysNumber(days: number): string {
  return String(Math.round(days * 10) / 10).replace('.', ',');
}

/**
 * Дни писем цепочки от запуска: [24, 24, 24] → «день 0, +1, +2, +3».
 * Задержка считается от предыдущего письма, а человеку понятнее, в какой
 * день от запуска уйдёт каждое.
 */
export function chainDaysLabel(delaysHours: number[]): string {
  let total = 0;
  const days = ['0'];
  for (const hours of delaysHours) {
    total += hours / 24;
    days.push(`+${daysNumber(total)}`);
  }
  return `день ${days.join(', ')}`;
}

/**
 * Пояс: частые — выбором, любой другой — вписать (Asia/Almaty). Вписанный
 * руками остаётся полем ввода, даже совпав с частым, — иначе поле исчезало
 * бы посреди набора.
 */
function TimezonePicker({ value, valid, onChange }: { value: string; valid: boolean; onChange: (value: string) => void }) {
  const [custom, setCustom] = useState(() => !COMMON_TIMEZONES.some((tz) => tz.id === value));
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <select
        value={custom ? CUSTOM_TIMEZONE : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM_TIMEZONE) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(e.target.value);
        }}
        className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-900 focus:outline-none"
      >
        {COMMON_TIMEZONES.map((tz) => (
          <option key={tz.id} value={tz.id}>
            {tz.label}
          </option>
        ))}
        <option value={CUSTOM_TIMEZONE}>Другой пояс…</option>
      </select>
      {custom ? (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Например, Asia/Almaty"
          spellCheck={false}
          aria-invalid={!valid}
          title="Название пояса, как в международном справочнике: Европа/Город или Азия/Город латиницей"
          className={`w-48 rounded-xl border bg-white px-3 py-1.5 text-sm text-zinc-900 focus:outline-none ${
            valid ? 'border-zinc-200' : 'border-red-300'
          }`}
        />
      ) : null}
    </div>
  );
}

interface Props {
  folder: SenderFolderDto;
  onClose: () => void;
  /** Папка после сохранения и итог для списка кампаний. */
  onSaved: (folder: SenderFolderDto, notice: string) => void | Promise<void>;
}

/**
 * Настройки папки рассылок: ящики, окно отправки, пояс, паузы и интервалы
 * писем цепочки.
 *
 * Папка — не кампания: настройки берёт себе каждая новая кампания, которую
 * заливка автоаутрича создаёт в этой папке, а уже созданные живут по своим.
 * Поэтому здесь нет писем и базы, и об этом сказано прямо в окне — иначе
 * правку папки ждали бы на идущей рассылке.
 */
export function FolderSettingsModal({ folder, onClose, onSaved }: Props) {
  const [mailboxes, setMailboxes] = useState<PickedMailbox[]>(folder.mailboxes);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hourFrom, setHourFrom] = useState(folder.send_hour_from);
  const [hourTo, setHourTo] = useState(folder.send_hour_to);
  const [weekdays, setWeekdays] = useState<number[]>(folder.send_weekdays);
  const [timezone, setTimezone] = useState(folder.timezone);
  const [gapSeconds, setGapSeconds] = useState(folder.gap_seconds);
  const [gapJitterSeconds, setGapJitterSeconds] = useState(folder.gap_jitter_seconds);
  // Интервалы — в днях, как о них думают: «второе письмо через день». В базе
  // часы. Поле, которого не касались, сохраняется в исходных часах — 36 ч не
  // превратятся в 48 из-за того, что поле показывает дни.
  const [initialHours] = useState(() => delaysOf(folder));
  const [initialDays] = useState(() => initialHours.map(daysValue));
  const [delayDays, setDelayDays] = useState<string[]>(initialDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delayHours = delayDays.map((text, index) => {
    if (text === initialDays[index]) return initialHours[index];
    const days = Number(text.trim().replace(',', '.'));
    return text.trim() && Number.isInteger(days) && days >= 1 && days <= MAX_DELAY_DAYS ? days * 24 : null;
  });
  const delaysValid = delayHours.every((hours) => hours != null);

  const timezoneValid = isKnownTimezone(timezone);
  const working = mailboxes.filter(isWorking).length;

  // Что мешает сохранить — один список: из него и подсказка внизу окна, и
  // запрет кнопки. Сервер проверяет то же самое, но ответ «нельзя» после
  // нажатия хуже, чем причина на экране до него.
  const problems: string[] = [];
  if (!Number.isInteger(hourFrom) || hourFrom < 0 || hourFrom > 23) {
    problems.push('Начало окна отправки — час от 0 до 23');
  } else if (!Number.isInteger(hourTo) || hourTo < 1 || hourTo > 24) {
    problems.push('Конец окна отправки — час от 1 до 24');
  } else if (hourTo <= hourFrom) {
    problems.push('Конец окна отправки должен быть позже начала');
  }
  if (!weekdays.length) problems.push('Выберите хотя бы один день отправки');
  if (!timezoneValid) problems.push('Неизвестный часовой пояс — впишите его латиницей, например Europe/Moscow');
  if (gapSeconds > MAX_GAP_SECONDS || gapJitterSeconds > MAX_GAP_SECONDS) {
    problems.push(`Пауза между письмами — не больше ${MAX_GAP_SECONDS} секунд`);
  }
  delayHours.forEach((hours, index) => {
    if (hours == null) problems.push(`Письмо ${index + 2}: укажите целое число дней от 1 до ${MAX_DELAY_DAYS}`);
  });
  const scheduleDone = weekdays.length > 0 && timezoneValid && hourTo > hourFrom;

  const save = async () => {
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await updateFolder(folder.id, {
        timezone: timezone.trim(),
        sendHourFrom: hourFrom,
        sendHourTo: hourTo,
        sendWeekdays: weekdays,
        gapSeconds,
        gapJitterSeconds,
        stepDelaysHours: delayHours.map((hours) => hours ?? DEFAULT_DELAY_HOURS),
        mailboxIds: mailboxes.map((mailbox) => mailbox.id),
      });
      const dropped = res.droppedMailboxes
        ? ` ${res.droppedMailboxes} из выбранных ящиков уже удалены — они не сохранены.`
        : '';
      await onSaved(res.folder, `Настройки папки «${res.folder.name}» сохранены.${dropped}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить настройки папки');
      setSaving(false);
    }
  };

  const shown = mailboxes.slice(0, SHOWN_MAILBOXES);
  const rest = mailboxes.length - shown.length;

  return (
    <>
      <SenderModal
        title={`Настройки папки «${folder.name}»`}
        subtitle="Ящики, расписание и интервалы писем для новых кампаний папки"
        size="wide"
        onClose={onClose}
        footer={
          <>
            {error ? (
              <span className="mr-auto text-sm text-red-600">{error}</span>
            ) : problems.length ? (
              <span className="mr-auto text-sm text-amber-600">{problems[0]}</span>
            ) : (
              <span className="mr-auto text-xs text-zinc-500">Действует на кампании, созданные после сохранения</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || problems.length > 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Сохранить
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {/* Главное недоразумение с папкой — ждать, что правка догонит уже
              созданные рассылки. Говорим об этом до того, как что-то менять. */}
          <p className="rounded-lg bg-zinc-50 px-3.5 py-3 text-xs leading-relaxed text-zinc-600">
            Эти настройки получает каждая новая кампания, которую создаёт кнопка «Залить в Рассылку» на экране
            запуска автоаутрича. Уже созданные кампании живут по своим настройкам — их меняют в самой кампании
            (клик по названию). Одно исключение: кампания без ящиков при запуске возьмёт ящики этой папки.
          </p>

          <Step
            no={1}
            title="Ящики для отправки"
            done={mailboxes.length > 0}
            hint={mailboxes.length ? `Выбрано: ${mailboxes.length}` : undefined}
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100"
              >
                <Mail className="h-3.5 w-3.5" />
                {mailboxes.length ? 'Изменить' : 'Выбрать'}
              </button>
              {mailboxes.length === 0 ? (
                <span className="text-sm text-zinc-500">Ни одного не выбрано</span>
              ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {shown.map((mailbox) => (
                    <span
                      key={mailbox.id}
                      title={isWorking(mailbox) ? undefined : 'Сейчас не отправляет: не прошёл проверку входа или снята галочка «берём в рассылку»'}
                      className={`rounded-lg px-2 py-1 text-xs ${
                        isWorking(mailbox) ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {mailbox.email}
                    </span>
                  ))}
                  {rest > 0 ? <span className="text-xs text-zinc-500">и ещё {rest}</span> : null}
                </div>
              )}
            </div>
            {/* Рабочие — те, с которых реально уйдут письма: статус «Готов» и
                галочка на вкладке «Ящики». Выбрать можно любой, но без
                единого рабочего кампании папки не запустятся. */}
            {mailboxes.length === 0 ? (
              <p className="mt-2 text-xs text-amber-600">
                Без ящиков кампании этой папки не запустятся: кнопка «Запустить» попросит выбрать их здесь.
              </p>
            ) : working === 0 ? (
              <p className="mt-2 text-xs text-amber-600">
                Ни один выбранный ящик сейчас не может отправлять: нужен статус «Готов» и галочка «берём в
                рассылку» на вкладке «Ящики».
              </p>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">
                {working === mailboxes.length
                  ? 'Все выбранные ящики могут отправлять — письма кампании уходят с них по очереди.'
                  : `Могут отправлять ${working} из ${mailboxes.length}: письма уходят только с ящиков в статусе «Готов» и с галочкой «берём в рассылку».`}
              </p>
            )}
          </Step>

          <ScheduleStep
            no={2}
            done={scheduleDone}
            hourFrom={hourFrom}
            hourTo={hourTo}
            weekdays={weekdays}
            timezone={timezone}
            gapSeconds={gapSeconds}
            gapJitterSeconds={gapJitterSeconds}
            onHourFrom={setHourFrom}
            onHourTo={setHourTo}
            onWeekdays={setWeekdays}
            onTimezone={setTimezone}
            onGapSeconds={setGapSeconds}
            onGapJitterSeconds={setGapJitterSeconds}
            timezoneControl={<TimezonePicker value={timezone} valid={timezoneValid} onChange={setTimezone} />}
          />

          <Step
            no={3}
            title="Интервалы писем"
            done={delaysValid}
            hint={delaysValid ? chainDaysLabel(delayHours.map((hours) => hours ?? DEFAULT_DELAY_HOURS)) : undefined}
          >
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-16 text-xs text-zinc-500">Письмо 1</span>
                <span className="text-sm text-zinc-700">в день запуска кампании</span>
              </div>
              {delayDays.map((text, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-16 text-xs text-zinc-500">Письмо {index + 2}</span>
                  <span className="text-xs text-zinc-500">через</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_DELAY_DAYS}
                    step={1}
                    value={text}
                    aria-label={`Письмо ${index + 2}: через сколько дней после письма ${index + 1}`}
                    aria-invalid={delayHours[index] == null}
                    onChange={(e) =>
                      setDelayDays((prev) => prev.map((value, i) => (i === index ? e.target.value : value)))
                    }
                    className={`w-16 rounded-lg border bg-white px-2 py-1 text-center text-sm text-zinc-900 ${
                      delayHours[index] == null ? 'border-red-300' : 'border-zinc-300'
                    }`}
                  />
                  <span className="text-xs text-zinc-500">дн. после письма {index + 1}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Письма 2–4 уходят ответом в ту же переписку. Если письмо выпадает на день или час, когда отправка
              выключена, оно уйдёт в ближайшее разрешённое время.
            </p>
          </Step>
        </div>
      </SenderModal>

      {pickerOpen ? (
        <MailboxPickerModal
          initial={mailboxes}
          subtitle="Письма новых кампаний папки уходят по очереди со всех выбранных ящиков"
          onClose={() => setPickerOpen(false)}
          onSave={(picked) => {
            setMailboxes(picked);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
