'use client';

import { useState, type ReactNode } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { createCampaign } from './api';
import { MailboxPickerModal, type PickedMailbox } from './MailboxPickerModal';
import { SenderModal } from './SenderModal';

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

const WORKDAYS = [1, 2, 3, 4, 5];
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

/** Сколько адресов показываем в строке выбора до того, как перейти на «и ещё N». */
const SHOWN_MAILBOXES = 4;

/**
 * Шаг формы: номер, заголовок и сводка справа.
 *
 * Номера — не украшение: до них четыре одинаковых блока в рамках читались как
 * одна простыня, и было не видно ни порядка, ни того, что уже заполнено.
 * Заполненный шаг подсвечивает номер, поэтому пропущенный виден сразу.
 */
function Step({
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

interface Props {
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}

export function CampaignFormModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [mailboxes, setMailboxes] = useState<PickedMailbox[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Кампания — это одно письмо. Follow-up'ы убраны: цепочку ведём не догоняющими
  // письмами, а работой с ответами. Формат запроса к API прежний (список писем),
  // и планировщик сам закрывает получателя после первого письма.
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [hourFrom, setHourFrom] = useState(9);
  const [hourTo, setHourTo] = useState(18);
  // Будни по умолчанию: холодная рассылка в выходные бьёт по ответам и по
  // репутации домена. Но это умолчание, а не запрет — день включается кнопкой.
  const [weekdays, setWeekdays] = useState<number[]>([...WORKDAYS]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleWeekday = (id: number) => {
    setWeekdays((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id].sort((a, b) => a - b)));
  };

  /**
   * Готовность шагов — один список, из которого берутся и подсветка номера, и
   * запрет на создание, и подсказка внизу окна. Пока это жило в трёх местах,
   * «Создать кампанию» соглашалась на полупустую форму, а отказ прилетал уже
   * с сервера: «Выберите хотя бы один ящик» без указания, где этот шаг.
   */
  const steps = [
    { no: 1, title: 'название', done: Boolean(name.trim()) },
    { no: 2, title: 'ящики', done: mailboxes.length > 0 },
    { no: 3, title: 'письмо', done: Boolean(subject.trim() && body.trim()) },
    { no: 4, title: 'дни отправки', done: weekdays.length > 0 },
  ];
  const missing = steps.filter((step) => !step.done);

  const submit = async () => {
    if (missing.length) {
      setError(`Заполните шаги: ${missing.map((step) => `${step.no} — ${step.title}`).join(', ')}`);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createCampaign({
        name,
        mailboxIds: mailboxes.map((m) => m.id),
        steps: [{ delayDays: 0, subject, body }],
        sendHourFrom: hourFrom,
        sendHourTo: hourTo,
        sendWeekdays: weekdays,
      });
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать кампанию');
      setCreating(false);
    }
  };

  const shown = mailboxes.slice(0, SHOWN_MAILBOXES);
  const rest = mailboxes.length - shown.length;

  return (
    <>
      <SenderModal
        title="Новая кампания"
        subtitle="Одно письмо по базе получателей с выбранных ящиков"
        size="wide"
        onClose={onClose}
        footer={
          <>
            {/* Что мешает создать — видно сразу и всё время, а не после
                нажатия: полоса действий не прокручивается вместе с формой. */}
            {error ? (
              <span className="mr-auto text-sm text-red-600">{error}</span>
            ) : missing.length ? (
              <span className="mr-auto text-sm text-amber-600">
                Заполните шаги: {missing.map((step) => `${step.no} — ${step.title}`).join(', ')}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={creating || missing.length > 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Создать кампанию
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Step no={1} title="Название кампании" done={steps[0].done}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например: клиники Москвы, сентябрь"
              className="w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900"
            />
          </Step>

          {/* Ящиков бывают сотни — в шаге живёт не список, а итог выбора:
              четыре адреса целиком и счётчик остальных. Сам выбор — в окне
              с поиском, иначе форма превращается в простыню из адресов. */}
          <Step
            no={2}
            title="Ящики для отправки"
            done={steps[1].done}
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
                      className="rounded-lg bg-blue-50 px-2 py-1 text-xs text-blue-700"
                    >
                      {mailbox.email}
                    </span>
                  ))}
                  {rest > 0 ? <span className="text-xs text-zinc-500">и ещё {rest}</span> : null}
                </div>
              )}
            </div>
          </Step>

          <Step no={3} title="Первое письмо" done={steps[2].done}>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Тема письма"
              className="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="Текст письма. Подстановки: {{first_name}}, {{name}}, {{company}} и любые колонки базы"
              className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
            />
          </Step>

          {/* Часы и дни — одно решение «когда отправлять», поэтому и на экране
              это один шаг, а не две разрозненные строки полей. */}
          <Step
            no={4}
            title="Когда отправлять"
            done={steps[3].done}
            hint={`${hourFrom}:00–${hourTo}:00 · ${weekdaysLabel(weekdays)} · Москва`}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
              <span className="w-10 text-xs uppercase tracking-wide text-zinc-500">Часы</span>
              <div className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={hourFrom}
                  onChange={(e) => setHourFrom(Number(e.target.value))}
                  className="w-12 border-0 bg-transparent p-0 text-center text-sm font-medium text-zinc-900 focus:outline-none"
                />
                <span className="text-zinc-400">—</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={hourTo}
                  onChange={(e) => setHourTo(Number(e.target.value))}
                  className="w-12 border-0 bg-transparent p-0 text-center text-sm font-medium text-zinc-900 focus:outline-none"
                />
              </div>
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
                      onClick={() => toggleWeekday(day.id)}
                      className={`min-w-11 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
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
                      onClick={() => setWeekdays([...preset.days])}
                      className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                        active ? 'bg-blue-50 text-blue-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setWeekdays([])}
                  disabled={weekdays.length === 0}
                  className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  Снять все
                </button>
              </div>
            </div>

            {/* Кампания без дней не поедет вовсе — это стоит увидеть до нажатия
                кнопки, а не в сообщении об ошибке после. */}
            {weekdays.length === 0 ? (
              <p className="mt-3 text-xs text-amber-600">Не выбрано ни одного дня — отправлять будет некогда.</p>
            ) : null}
          </Step>
        </div>
      </SenderModal>

      {pickerOpen ? (
        <MailboxPickerModal
          initial={mailboxes}
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
