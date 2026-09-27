'use client';

import { useRef, useState, type ReactNode } from 'react';
import { placeholderKeys } from '@/lib/sender/templateVars';
import type { RecipientColumnsDto } from './api';
import { TemplateField, insertVariable, placeCaret } from './TemplateField';

/**
 * Шаги формы кампании, одинаковые для создания и редактирования: оболочка
 * шага, письмо и окно отправки. Живут отдельно от самой формы, потому что
 * форма и так держит состояние, загрузку базы, выбор ящиков и сохранение.
 */

/** 1 = понедельник … 7 = воскресенье — так же, как в БД и в планировщике. */
export const WEEKDAYS = [
  { id: 1, label: 'Пн' },
  { id: 2, label: 'Вт' },
  { id: 3, label: 'Ср' },
  { id: 4, label: 'Чт' },
  { id: 5, label: 'Пт' },
  { id: 6, label: 'Сб' },
  { id: 7, label: 'Вс' },
];

export const WORKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];
const ALL_DAYS = WEEKDAYS.map((d) => d.id);

/** Готовые наборы: попасть в «будни» одним нажатием чаще, чем собирать пять галок. */
const DAY_PRESETS = [
  { label: 'Будни', days: WORKDAYS },
  { label: 'Выходные', days: WEEKEND },
  { label: 'Все дни', days: ALL_DAYS },
];

/** Дни кампании короткой строкой: «будни» читается быстрее, чем «Пн, Вт, Ср, Чт, Пт». */
export function weekdaysLabel(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (!set.length) return 'дни не выбраны';
  if (set.length === 7) return 'все дни';
  if (set.join() === WORKDAYS.join()) return 'будни';
  if (set.join() === WEEKEND.join()) return 'выходные';
  return WEEKDAYS.filter((d) => set.includes(d.id)).map((d) => d.label).join(', ');
}

/**
 * Шаг формы: номер, заголовок и сводка справа.
 *
 * Номера — не украшение: до них четыре одинаковых блока в рамках читались как
 * одна простыня, и было не видно ни порядка, ни того, что уже заполнено.
 * Заполненный шаг подсвечивает номер, поэтому пропущенный виден сразу.
 */
export function Step({
  no,
  title,
  hint,
  done,
  children,
}: {
  no: number;
  title: string;
  hint?: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
            done ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-500'
          }`}
        >
          {no}
        </span>
        <h3 className="text-sm font-medium text-zinc-900">{title}</h3>
        {hint ? <span className="ml-auto text-xs text-zinc-500">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Что не так с текстом письма относительно базы.
 *
 * Считается и формой (шаг заполнен или нет), и самим шагом (что показать
 * под полем) — поэтому правило живёт в одном месте.
 */
export function letterIssues(subject: string, body: string, columns: RecipientColumnsDto | null) {
  const variables = columns?.variables ?? [];
  const knownKeys = new Set(variables.map((v) => v.key));
  const usedKeys = placeholderKeys(`${subject}\n${body}`);
  return {
    variables,
    usedKeys,
    // Переменные, которых нет в базе, при отправке молча стали бы пустотой —
    // поэтому это ошибка шага, а не предупреждение.
    unknownKeys: columns ? usedKeys.filter((key) => !knownKeys.has(key)) : [],
    partlyEmpty: columns
      ? variables.filter((v) => usedKeys.includes(v.key) && v.filled < columns.recipients)
      : [],
  };
}

interface LetterProps {
  no: number;
  done: boolean;
  subject: string;
  body: string;
  onSubject: (value: string) => void;
  onBody: (value: string) => void;
  columns: RecipientColumnsDto | null;
  /** Счётчики «заполнено у N» посчитаны по всей базе, а не по выборке. */
  countsExact?: boolean;
  /** Подпись, когда базы ещё нет: у создания и у правки она разная. */
  emptyHint: string;
  disabled?: boolean;
  /** Название шага: «Первое письмо», «Письмо 2»… */
  title?: string;
  /** Через сколько часов после предыдущего письма уйдёт этот шаг. */
  delayHours?: number;
  onDelayHours?: (value: number) => void;
  onRemove?: () => void;
}

/**
 * Шаг «Письмо» цепочки: тема, текст и переменные из базы. Пустая тема у
 * follow-up — норма: письмо уйдёт ответом в тот же тред с «Re:».
 */
export function LetterStep({
  no,
  done,
  subject,
  body,
  onSubject,
  onBody,
  columns,
  countsExact = true,
  emptyHint,
  disabled = false,
  title = 'Первое письмо',
  delayHours,
  onDelayHours,
  onRemove,
}: LetterProps) {
  const subjectRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  // Куда вставлять переменную по клику на подсказку — в поле, где был курсор.
  const [lastField, setLastField] = useState<'subject' | 'body'>('body');
  const { variables, unknownKeys, partlyEmpty } = letterIssues(subject, body, columns);

  const insertAtCursor = (key: string) => {
    const isSubject = lastField === 'subject';
    const el = (isSubject ? subjectRef : bodyRef).current;
    const text = isSubject ? subject : body;
    const next = insertVariable(text, el?.selectionStart ?? text.length, key);
    (isSubject ? onSubject : onBody)(next.text);
    placeCaret(el, next.caret);
  };

  return (
    <Step
      no={no}
      title={title}
      done={done}
      hint={
        delayHours != null && onDelayHours
          ? `через ${delayHours} ч после предыдущего`
          : undefined
      }
    >
      {/* Задержка и удаление — атрибуты шага цепочки, а не письма: живут
          в шапке шага, чтобы текст оставался только текстом. */}
      {delayHours != null && onDelayHours ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          <span className="text-xs text-zinc-500">Отправить через</span>
          <input
            type="number"
            min={1}
            max={720}
            value={delayHours}
            disabled={disabled}
            onChange={(e) => onDelayHours(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            className="w-16 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-center text-sm text-zinc-900"
          />
          <span className="text-xs text-zinc-500">
            ч после предыдущего письма (тему можно оставить пустой — уйдёт как «Re:» в тот же тред)
          </span>
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              className="ml-auto text-xs text-zinc-400 transition-colors hover:text-red-600 disabled:opacity-50"
            >
              Убрать шаг
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="mb-2">
        <TemplateField
          value={subject}
          onChange={onSubject}
          variables={variables}
          fieldRef={subjectRef}
          onFocus={() => setLastField('subject')}
          placeholder={delayHours != null ? 'Тема (пусто = «Re:» в тот же тред)' : 'Тема письма'}
          disabled={disabled}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
        />
      </div>
      <TemplateField
        multiline
        value={body}
        onChange={onBody}
        variables={variables}
        fieldRef={bodyRef}
        onFocus={() => setLastField('body')}
        rows={8}
        placeholder="Здравствуйте, {{first_name}}! Пишу по поводу {{company_name}}…"
        disabled={disabled}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
      />

      {/* Переменные — из колонок базы: клик вставляет в поле, где стоял
          курсор; то же самое выпадает подсказкой после «{{». */}
      {columns ? (
        <div className="mt-3">
          <p className="mb-1.5 text-xs text-zinc-500">
            Переменные из базы — нажмите, чтобы вставить, или наберите {'{{'} в тексте:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {variables.map((v) => {
              const partial = countsExact && v.filled < columns.recipients;
              return (
                <button
                  key={v.key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertAtCursor(v.key)}
                  disabled={disabled}
                  title={[
                    v.header ? `Колонка «${v.header}»` : 'Из почты / имени получателя',
                    v.sample ? `например: ${v.sample}` : null,
                    countsExact ? `заполнено у ${v.filled} из ${columns.recipients}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  className={`rounded-lg px-2 py-1 font-mono text-xs transition-colors disabled:opacity-60 ${
                    partial
                      ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                      : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                  }`}
                >
                  {`{{${v.key}}}`}
                  {partial ? <span className="ml-1 font-sans">{v.filled}/{columns.recipients}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">{emptyHint}</p>
      )}

      {unknownKeys.length ? (
        <p className="mt-2 text-sm text-red-600">
          В базе нет колонок для {unknownKeys.map((k) => `{{${k}}}`).join(', ')} — у всех на этом месте
          будет пусто. Исправьте или уберите.
        </p>
      ) : null}
      {columns && countsExact && partlyEmpty.length ? (
        <p className="mt-2 text-xs text-amber-600">
          {partlyEmpty.map((v) => `{{${v.key}}} пусто у ${columns.recipients - v.filled}`).join(', ')}{' '}
          получателей — у них на этом месте ничего не будет.
        </p>
      ) : null}
    </Step>
  );
}

/** Часовые пояса кампаний: рынок рассылки плюс вся Россия для удобства. */
export const TIMEZONES = [
  'Europe/Moscow',
  'Europe/Kaliningrad',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Vladivostok',
  'Europe/Kyiv',
  'Europe/Minsk',
  'Europe/Astana',
  'Europe/Warsaw',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/London',
  'Europe/Istanbul',
  'Asia/Dubai',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
];

/** Человекочитаемая метка пояса: «Europe/Moscow» → «Москва». */
export function timezoneLabel(timezone: string): string {
  const part = timezone.split('/').pop() ?? timezone;
  return part.replace(/_/g, ' ');
}

interface ScheduleProps {
  no: number;
  done: boolean;
  hourFrom: number;
  hourTo: number;
  weekdays: number[];
  timezone: string;
  gapSeconds: number;
  gapJitterSeconds: number;
  onHourFrom: (value: number) => void;
  onHourTo: (value: number) => void;
  onWeekdays: (days: number[]) => void;
  onTimezone: (value: string) => void;
  onGapSeconds: (value: number) => void;
  onGapJitterSeconds: (value: number) => void;
  disabled?: boolean;
  /**
   * Своё поле пояса вместо списка TIMEZONES — у настроек папки, где пояс
   * можно вписать руками. Подпись «Пояс» и место в строке остаются общими.
   */
  timezoneControl?: ReactNode;
}

/**
 * Шаг «Когда отправлять». Часы, дни, пояс и паузы между письмами — одно
 * решение о ритме кампании, поэтому и на экране это один шаг.
 */
export function ScheduleStep({
  no,
  done,
  hourFrom,
  hourTo,
  weekdays,
  timezone,
  gapSeconds,
  gapJitterSeconds,
  onHourFrom,
  onHourTo,
  onWeekdays,
  onTimezone,
  onGapSeconds,
  onGapJitterSeconds,
  disabled = false,
  timezoneControl,
}: ScheduleProps) {
  const toggleWeekday = (id: number) => {
    onWeekdays(
      weekdays.includes(id)
        ? weekdays.filter((d) => d !== id)
        : [...weekdays, id].sort((a, b) => a - b),
    );
  };

  return (
    <Step
      no={no}
      title="Когда отправлять"
      done={done}
      hint={`${hourFrom}:00–${hourTo}:00 · ${weekdaysLabel(weekdays)} · ${timezoneLabel(timezone)}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
        <span className="w-10 text-xs uppercase tracking-wide text-zinc-500">Часы</span>
        <div className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5">
          <input
            type="number"
            min={0}
            max={23}
            value={hourFrom}
            disabled={disabled}
            onChange={(e) => onHourFrom(Number(e.target.value))}
            className="w-12 border-0 bg-transparent p-0 text-center text-sm font-medium text-zinc-900 focus:outline-none"
          />
          <span className="text-zinc-400">—</span>
          <input
            type="number"
            min={1}
            max={24}
            value={hourTo}
            disabled={disabled}
            onChange={(e) => onHourTo(Number(e.target.value))}
            className="w-12 border-0 bg-transparent p-0 text-center text-sm font-medium text-zinc-900 focus:outline-none"
          />
        </div>
        {/* Пояс обязателен: окно считается в локальном времени кампании, и без
            выбора всё навсегда остаётся московским — для ENG-рынка это мимо
            рабочих часов получателя. */}
        <span className="ml-2 text-xs uppercase tracking-wide text-zinc-500">Пояс</span>
        {timezoneControl ?? (
          <select
            value={timezone}
            disabled={disabled}
            onChange={(e) => onTimezone(e.target.value)}
            className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-900 focus:outline-none"
          >
            {/* Текущий пояс кампании может быть не в списке — показываем и его. */}
            {[...new Set([timezone, ...TIMEZONES])].map((tz) => (
              <option key={tz} value={tz}>{timezoneLabel(tz)}</option>
            ))}
          </select>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="w-10 text-xs uppercase tracking-wide text-zinc-500">Дни</span>
        {/* Переключатели вместо галок: день — это состояние «шлём / не шлём»,
            и семь подписанных кнопок читаются одним взглядом. */}
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1">
          {WEEKDAYS.map((day) => {
            const active = weekdays.includes(day.id);
            return (
              <button
                key={day.id}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => toggleWeekday(day.id)}
                className={`min-w-11 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 ${
                  active ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700'
                }`}
              >
                {day.label}
              </button>
            );
          })}
        </div>

        <div className="inline-flex flex-wrap items-center gap-1">
          {DAY_PRESETS.map((preset) => {
            // Подсветка набора показывает, что выбор ему ровно соответствует:
            // иначе после ручной правки дней непонятно, «будни» это ещё или уже нет.
            const active = weekdays.join() === [...preset.days].join();
            return (
              <button
                key={preset.label}
                type="button"
                disabled={disabled}
                onClick={() => onWeekdays([...preset.days])}
                className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors disabled:opacity-60 ${
                  active ? 'bg-blue-50 text-blue-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onWeekdays([])}
            disabled={disabled || weekdays.length === 0}
            className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Снять все
          </button>
        </div>
      </div>

      {/* Пауза между письмами одного ящика: базовая + случайная добавка, чтобы
          отправка не выглядела машинной пачкой. Задаётся при создании и правится
          здесь же — раньше после создания её нельзя было увидеть вообще. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
        <span className="w-10 text-xs uppercase tracking-wide text-zinc-500">Пауза</span>
        <div className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5">
          <input
            type="number"
            min={0}
            max={3600}
            value={gapSeconds}
            disabled={disabled}
            onChange={(e) => onGapSeconds(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            className="w-14 border-0 bg-transparent p-0 text-center text-sm font-medium text-zinc-900 focus:outline-none"
          />
          <span className="text-xs text-zinc-400">±</span>
          <input
            type="number"
            min={0}
            max={3600}
            value={gapJitterSeconds}
            disabled={disabled}
            onChange={(e) => onGapJitterSeconds(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            className="w-14 border-0 bg-transparent p-0 text-center text-sm font-medium text-zinc-900 focus:outline-none"
          />
          <span className="text-xs text-zinc-400">сек</span>
        </div>
        <span className="text-xs text-zinc-500">между письмами одного ящика (случайная добавка — «±»)</span>
      </div>

      {/* Кампания без дней не поедет вовсе — это стоит увидеть до нажатия
          кнопки, а не в сообщении об ошибке после. */}
      {weekdays.length === 0 ? (
        <p className="mt-3 text-xs text-amber-600">Не выбрано ни одного дня — отправлять будет некогда.</p>
      ) : null}
    </Step>
  );
}
