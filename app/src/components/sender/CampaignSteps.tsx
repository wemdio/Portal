'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Split } from 'lucide-react';
import { hasBrokenLinkMarkup } from '@/lib/mail/linkMarkup';
import { placeholderKeys } from '@/lib/sender/templateVars';
import { MAX_VARIANTS, MIN_RECIPIENTS_PER_VARIANT, variantLabel } from '@/lib/sender/variants';
import type { RecipientColumnsDto } from './api';
import { LinkInsert } from './LetterLinks';
import { TemplateField, insertLink, insertVariable, placeCaret } from './TemplateField';

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

/** Одно письмо шага. Их несколько, когда у шага идёт А/Б-тест. */
export interface LetterVariant {
  subject: string;
  body: string;
}

/**
 * Поля одного письма: тема, текст, вставка ссылки и переменные базы.
 *
 * Отдельный компонент, потому что у шага таких писем бывает несколько
 * (варианты А/Б-теста), и у каждого свои курсор, выделение и подсказки.
 */
function LetterFields({
  letter,
  onChange,
  columns,
  countsExact,
  rows,
  subjectPlaceholder,
  disabled,
}: {
  letter: LetterVariant;
  onChange: (patch: Partial<LetterVariant>) => void;
  columns: RecipientColumnsDto | null;
  countsExact: boolean;
  rows: number;
  subjectPlaceholder: string;
  disabled: boolean;
}) {
  const subjectRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  // Куда вставлять переменную по клику на подсказку — в поле, где был курсор.
  const [lastField, setLastField] = useState<'subject' | 'body'>('body');
  // Выделение в тексте на момент открытия окошка ссылки: пока оператор
  // вписывает адрес, фокус уже не в письме, и выделение оттуда не прочитать.
  const linkRange = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const { variables, unknownKeys, partlyEmpty } = letterIssues(letter.subject, letter.body, columns);

  const insertAtCursor = (key: string) => {
    const isSubject = lastField === 'subject';
    const el = (isSubject ? subjectRef : bodyRef).current;
    const text = isSubject ? letter.subject : letter.body;
    const next = insertVariable(text, el?.selectionStart ?? text.length, key);
    onChange(isSubject ? { subject: next.text } : { body: next.text });
    placeCaret(el, next.caret);
  };

  /** Выделенный в письме текст — он же подпись будущей ссылки по умолчанию. */
  const grabSelection = () => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? letter.body.length;
    const end = el?.selectionEnd ?? start;
    linkRange.current = { start, end };
    return letter.body.slice(start, end).trim();
  };

  const addLink = (label: string, url: string) => {
    const { start, end } = linkRange.current;
    const next = insertLink(letter.body, start, end, label, url);
    onChange({ body: next.text });
    placeCaret(bodyRef.current, next.caret);
  };

  return (
    <>
      <div className="mb-2">
        <TemplateField
          value={letter.subject}
          onChange={(value) => onChange({ subject: value })}
          variables={variables}
          fieldRef={subjectRef}
          onFocus={() => setLastField('subject')}
          placeholder={subjectPlaceholder}
          disabled={disabled}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
        />
      </div>
      <TemplateField
        multiline
        value={letter.body}
        onChange={(value) => onChange({ body: value })}
        variables={variables}
        fieldRef={bodyRef}
        onFocus={() => setLastField('body')}
        rows={rows}
        placeholder="Здравствуйте, {{first_name}}! Пишу по поводу {{company_name}}…"
        disabled={disabled}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
      />

      {/* Ссылка под словом: выделили «Alial» — кнопка подставит подпись, адрес
          вписывается рядом. В тексте это остаётся разметкой с видимым адресом,
          синей ссылкой её покажет предпросмотр. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <LinkInsert disabled={disabled} onOpen={grabSelection} onInsert={addLink} />
        <span className="text-xs text-zinc-500">Выделите слово — оно станет подписью ссылки</span>
      </div>
      {hasBrokenLinkMarkup(letter.body) ? (
        <p className="mt-2 text-sm text-amber-600">
          Ссылка без «https://» останется в письме текстом — впишите адрес целиком.
        </p>
      ) : null}

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
      ) : null}

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
    </>
  );
}

interface LetterProps {
  no: number;
  done: boolean;
  /** Письма этого шага: одно — обычный шаг, несколько — А/Б-тест. */
  variants: LetterVariant[];
  onVariant: (index: number, patch: Partial<LetterVariant>) => void;
  onAddVariant?: () => void;
  onRemoveVariant?: (index: number) => void;
  columns: RecipientColumnsDto | null;
  /** Счётчики «заполнено у N» посчитаны по всей базе, а не по выборке. */
  countsExact?: boolean;
  /** Подпись, когда базы ещё нет: у создания и у правки она разная. */
  emptyHint: string;
  disabled?: boolean;
  /** Название шага: «Первое письмо», «Письмо 2»… */
  title?: string;
  /** Высота поля письма в строках: на странице настроек она больше, чем в окне. */
  rows?: number;
  /** Через сколько часов после предыдущего письма уйдёт этот шаг. */
  delayHours?: number;
  onDelayHours?: (value: number) => void;
  onRemove?: () => void;
}

/**
 * Шаг «Письмо» цепочки: тема, текст и переменные из базы. Пустая тема у
 * follow-up — норма: письмо уйдёт ответом в тот же тред с «Re:».
 *
 * А/Б-тест: у шага может быть несколько вариантов письма. База делится между
 * ними поровну, каждый получатель попадает в один вариант и остаётся в нём
 * (lib/sender/variants.ts) — иначе ответ нельзя было бы приписать тексту.
 */
export function LetterStep({
  no,
  done,
  variants,
  onVariant,
  onAddVariant,
  onRemoveVariant,
  columns,
  countsExact = true,
  emptyHint,
  disabled = false,
  title = 'Первое письмо',
  rows = 8,
  delayHours,
  onDelayHours,
  onRemove,
}: LetterProps) {
  const testing = variants.length > 1;

  return (
    <Step
      no={no}
      title={title}
      done={done}
      hint={[
        delayHours != null && onDelayHours ? `через ${delayHours} ч после предыдущего` : null,
        testing ? `А/Б-тест: ${variants.length} варианта` : null,
      ]
        .filter(Boolean)
        .join(' · ') || undefined}
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
      {variants.map((letter, index) => (
        <div
          key={index}
          className={testing ? 'mb-3 rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 last:mb-0' : ''}
        >
          {testing ? (
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-md bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700">
                Вариант {variantLabel(index + 1)}
              </span>
              {onRemoveVariant && !disabled ? (
                <button
                  type="button"
                  onClick={() => onRemoveVariant(index)}
                  className="ml-auto text-xs text-zinc-400 transition-colors hover:text-red-600"
                >
                  Убрать вариант
                </button>
              ) : null}
            </div>
          ) : null}
          <LetterFields
            letter={letter}
            onChange={(patch) => onVariant(index, patch)}
            columns={columns}
            countsExact={countsExact}
            rows={rows}
            subjectPlaceholder={delayHours != null ? 'Тема (пусто = «Re:» в тот же тред)' : 'Тема письма'}
            disabled={disabled}
          />
        </div>
      ))}

      {/* А/Б-тест: второй вариант письма этого же шага. База делится поровну,
          и через неделю видно, на какой текст больше ответов. */}
      {onAddVariant && !disabled && variants.length < MAX_VARIANTS ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onAddVariant}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:border-blue-400 hover:text-blue-600"
          >
            <Split className="h-3.5 w-3.5" />
            {testing ? 'Ещё вариант' : 'А/Б-тест: второй вариант'}
          </button>
          <span className="text-xs text-zinc-500">
            {testing
              ? `База разделится поровну между вариантами — нужно от ${MIN_RECIPIENTS_PER_VARIANT} адресов на каждый`
              : 'Два текста на одну базу — сравним по ответам'}
          </span>
        </div>
      ) : null}

      {columns ? null : <p className="mt-2 text-xs text-zinc-500">{emptyHint}</p>}
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
 * Час из поля ввода в допустимых границах. Пустое поле и нечисло оставляют
 * прежнее значение: иначе на середине набора («1» → стёрли → NaN) час
 * обнулялся бы сам.
 */
function clampHour(raw: string, current: number, min: number, max: number): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) return current;
  return Math.min(max, Math.max(min, Math.round(value)));
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
          {/* Границы держим кодом, а не только атрибутами min/max: их слушают
              только стрелки, а вписать руками можно было и 99, и −5 — окно
              отправки от такого молча становилось пустым. */}
          <input
            type="number"
            min={0}
            max={23}
            value={hourFrom}
            disabled={disabled}
            onChange={(e) => onHourFrom(clampHour(e.target.value, hourFrom, 0, 23))}
            className="w-12 border-0 bg-transparent p-0 text-center text-sm font-medium text-zinc-900 focus:outline-none"
          />
          <span className="text-zinc-400">—</span>
          <input
            type="number"
            min={1}
            max={24}
            value={hourTo}
            disabled={disabled}
            onChange={(e) => onHourTo(clampHour(e.target.value, hourTo, 1, 24))}
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
      {/* Час начала не раньше часа конца — иначе окно пустое и письма не едут,
          а на экране это выглядит как работающая кампания. */}
      {hourFrom >= hourTo ? (
        <p className="mt-3 text-xs text-amber-600">
          Начало не раньше конца ({hourFrom}:00–{hourTo}:00) — в такое окно отправлять нечего.
        </p>
      ) : null}
    </Step>
  );
}
