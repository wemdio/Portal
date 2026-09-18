'use client';

import { useRef, useState, type ReactNode } from 'react';
import { FileSpreadsheet, Loader2, Mail } from 'lucide-react';
import { placeholderKeys } from '@/lib/sender/templateVars';
import { createCampaign, previewRecipients, uploadRecipients, type RecipientColumnsDto } from './api';
import { TemplateField, insertVariable, placeCaret } from './TemplateField';
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
  /** notice — итог для списка кампаний: сколько получателей легло или почему база не загрузилась. */
  onCreated: (result: { notice?: string; error?: string }) => void | Promise<void>;
}

export function CampaignFormModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [mailboxes, setMailboxes] = useState<PickedMailbox[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // База получателей выбирается прямо в форме: раньше её можно было загрузить
  // только кнопкой в списке уже созданной кампании, и из формы было непонятно,
  // кому вообще уйдёт письмо.
  // Файл сразу разбирается на сервере (без записи): какие колонки нашлись и
  // какие переменные можно вставить в письмо. Файл без колонки почты не
  // принимается — такую базу некому отправлять.
  const [recipientsFile, setRecipientsFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<RecipientColumnsDto | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  // Куда вставлять переменную по клику на подсказку — в поле, где был курсор.
  const [lastField, setLastField] = useState<'subject' | 'body'>('body');
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

  const pickFile = async (file: File) => {
    setRecipientsFile(null);
    setColumns(null);
    setFileError(null);
    setPreviewing(true);
    try {
      const res = await previewRecipients(file);
      if (!res.emailHeader) {
        setFileError('В файле не нашлось колонки с почтой — назовите её email или «Почта».');
      } else if (!res.recipients) {
        setFileError('В колонке с почтой нет ни одного корректного адреса.');
      } else {
        setRecipientsFile(file);
        setColumns(res);
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Не удалось прочитать файл');
    } finally {
      setPreviewing(false);
    }
  };

  const variables = columns?.variables ?? [];
  const knownKeys = new Set(variables.map((v) => v.key));
  const usedKeys = placeholderKeys(`${subject}\n${body}`);
  // Переменные, которых нет в базе, при отправке молча стали бы пустотой —
  // поэтому это ошибка шага, а не предупреждение.
  const unknownKeys = columns ? usedKeys.filter((key) => !knownKeys.has(key)) : [];
  const partlyEmpty = columns
    ? variables.filter((v) => usedKeys.includes(v.key) && v.filled < columns.recipients)
    : [];

  const insertAtCursor = (key: string) => {
    const isSubject = lastField === 'subject';
    const el = (isSubject ? subjectRef : bodyRef).current;
    const text = isSubject ? subject : body;
    const next = insertVariable(text, el?.selectionStart ?? text.length, key);
    (isSubject ? setSubject : setBody)(next.text);
    placeCaret(el, next.caret);
  };

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
    { no: 2, title: 'база получателей', done: recipientsFile != null && columns != null },
    { no: 3, title: 'ящики', done: mailboxes.length > 0 },
    { no: 4, title: 'письмо', done: Boolean(subject.trim() && body.trim()) && unknownKeys.length === 0 },
    { no: 5, title: 'дни отправки', done: weekdays.length > 0 },
  ];
  const missing = steps.filter((step) => !step.done);

  const submit = async () => {
    if (missing.length) {
      setError(`Заполните шаги: ${missing.map((step) => `${step.no} — ${step.title}`).join(', ')}`);
      return;
    }
    if (!recipientsFile) return;
    setCreating(true);
    setError(null);
    let campaignId: string;
    try {
      ({ id: campaignId } = await createCampaign({
        name,
        mailboxIds: mailboxes.map((m) => m.id),
        steps: [{ delayDays: 0, subject, body }],
        sendHourFrom: hourFrom,
        sendHourTo: hourTo,
        sendWeekdays: weekdays,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать кампанию');
      setCreating(false);
      return;
    }

    // Кампания уже создана — если база не легла, окно всё равно закрываем:
    // повторное «Создать» завело бы дубль. Базу тогда догружают кнопкой в списке.
    try {
      const res = await uploadRecipients(campaignId, recipientsFile);
      await onCreated({
        notice:
          `Кампания создана, получателей: ${res.imported}. Пропущено: ${res.skippedInvalid} с плохим адресом, ` +
          `${res.skippedDuplicates} дублей, ${res.skippedSuppressed} из стоп-листа. ` +
          'Это черновик: письма пойдут после кнопки «Запустить».',
      });
    } catch (err) {
      await onCreated({
        error: `Кампания создана, но база не загрузилась: ${
          err instanceof Error ? err.message : 'ошибка'
        }. Загрузите её кнопкой «База получателей» в списке.`,
      });
    }
    onClose();
  };

  const shown = mailboxes.slice(0, SHOWN_MAILBOXES);
  const rest = mailboxes.length - shown.length;

  return (
    <>
      <SenderModal
        title="Новая кампания"
        subtitle="Одно письмо по загруженной базе с выбранных ящиков"
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
            ) : (
              <span className="mr-auto text-xs text-zinc-500">
                Кампания создастся черновиком — письма пойдут только после «Запустить» в списке
              </span>
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

          <Step
            no={2}
            title="Кому отправлять"
            done={steps[1].done}
            hint={recipientsFile ? recipientsFile.name : undefined}
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={previewing}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
              >
                {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                {previewing ? 'Читаю файл…' : recipientsFile ? 'Другой файл' : 'Загрузить базу'}
              </button>
              <span className="text-sm text-zinc-500">
                {recipientsFile ? recipientsFile.name : 'Файл не выбран'}
              </span>
            </div>

            {fileError ? <p className="mt-2 text-sm text-red-600">{fileError}</p> : null}

            {columns ? (
              <div className="mt-3 space-y-1 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600">
                <p>
                  <span className="text-zinc-900">{columns.recipients}</span> получателей
                  {columns.invalid || columns.duplicates
                    ? ` · пропустим ${columns.invalid} с плохим адресом и ${columns.duplicates} дублей`
                    : ''}
                  {' · '}стоп-лист проверим при создании
                </p>
                <p>
                  Почта — колонка «{columns.emailHeader}»
                  {columns.nameHeader
                    ? `, имя — «${columns.nameHeader}»`
                    : '. Колонки с именем нет — {{name}} и {{first_name}} недоступны'}
                </p>
                <p>
                  Своих переменных: {variables.filter((v) => v.header && v.header !== columns.nameHeader).length} —
                  их можно вставить в письмо (шаг 4)
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                CSV или Excel до 20 МБ, первая строка — названия колонок. Обязательна колонка с почтой
                (email, «Почта»); по желанию — с именем (name, «Имя», ФИО). Все остальные колонки станут
                переменными письма: «companyName» или «Company Name» → {'{{company_name}}'}, «Город» →{' '}
                {'{{город}}'}.
              </p>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void pickFile(file);
                e.target.value = '';
              }}
            />
          </Step>

          {/* Ящиков бывают сотни — в шаге живёт не список, а итог выбора:
              четыре адреса целиком и счётчик остальных. Сам выбор — в окне
              с поиском, иначе форма превращается в простыню из адресов. */}
          <Step
            no={3}
            title="Ящики для отправки"
            done={steps[2].done}
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

          <Step no={4} title="Первое письмо" done={steps[3].done}>
            <div className="mb-2">
              <TemplateField
                value={subject}
                onChange={setSubject}
                variables={variables}
                fieldRef={subjectRef}
                onFocus={() => setLastField('subject')}
                placeholder="Тема письма"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
              />
            </div>
            <TemplateField
              multiline
              value={body}
              onChange={setBody}
              variables={variables}
              fieldRef={bodyRef}
              onFocus={() => setLastField('body')}
              rows={8}
              placeholder="Здравствуйте, {{first_name}}! Пишу по поводу {{company_name}}…"
              className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
            />

            {/* Переменные — из колонок базы шага 2: клик вставляет в поле, где
                стоял курсор; то же самое выпадает подсказкой после «{{». */}
            {columns ? (
              <div className="mt-3">
                <p className="mb-1.5 text-xs text-zinc-500">
                  Переменные из базы — нажмите, чтобы вставить, или наберите {'{{'} в тексте:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {variables.map((v) => {
                    const partial = v.filled < columns.recipients;
                    return (
                      <button
                        key={v.key}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertAtCursor(v.key)}
                        title={[
                          v.header ? `Колонка «${v.header}»` : 'Из почты / имени получателя',
                          v.sample ? `например: ${v.sample}` : null,
                          `заполнено у ${v.filled} из ${columns.recipients}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        className={`rounded-lg px-2 py-1 font-mono text-xs transition-colors ${
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
              <p className="mt-2 text-xs text-zinc-500">
                Загрузите базу (шаг 2) — здесь появятся переменные из её колонок.
              </p>
            )}

            {unknownKeys.length ? (
              <p className="mt-2 text-sm text-red-600">
                В базе нет колонок для {unknownKeys.map((k) => `{{${k}}}`).join(', ')} — у всех на этом месте
                будет пусто. Исправьте или уберите.
              </p>
            ) : null}
            {columns && partlyEmpty.length ? (
              <p className="mt-2 text-xs text-amber-600">
                {partlyEmpty.map((v) => `{{${v.key}}} пусто у ${columns.recipients - v.filled}`).join(', ')}{' '}
                получателей — у них на этом месте ничего не будет.
              </p>
            ) : null}
          </Step>

          {/* Часы и дни — одно решение «когда отправлять», поэтому и на экране
              это один шаг, а не две разрозненные строки полей. */}
          <Step
            no={5}
            title="Когда отправлять"
            done={steps[4].done}
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
