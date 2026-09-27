'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, Mail } from 'lucide-react';
import {
  createCampaign,
  fetchCampaign,
  previewCampaignSteps,
  previewRecipients,
  updateCampaign,
  uploadRecipients,
  type CampaignDto,
  type PreviewSampleDto,
  type RecipientColumnsDto,
} from './api';
import { LetterStep, ScheduleStep, Step, WORKDAYS, letterIssues } from './CampaignSteps';
import { MailboxPickerModal, type PickedMailbox } from './MailboxPickerModal';
import { SenderModal } from './SenderModal';

/** Сколько адресов показываем в строке выбора до того, как перейти на «и ещё N». */
const SHOWN_MAILBOXES = 4;

const STATUS_HINT: Record<CampaignDto['status'], string> = {
  draft: 'Черновик — письма пойдут только после «Запустить» в списке',
  paused: 'Кампания на паузе. Правки подействуют на тех, кому ещё не отправляли',
  running: 'Кампания идёт — чтобы править, поставьте её на паузу в списке',
  done: 'Кампания завершена — её можно только посмотреть',
};

interface Props {
  /** Правка существующей кампании; без неё окно создаёт новую. */
  campaign?: CampaignDto;
  onClose: () => void;
  /** notice — итог для списка кампаний: сколько получателей легло или почему база не загрузилась. */
  onCreated: (result: { notice?: string; error?: string }) => void | Promise<void>;
}

/**
 * Окно кампании: создание и правка одной формой.
 *
 * Форма одна намеренно — набор решений («кому», «с чего», «что пишем»,
 * «когда») у создания и у правки совпадает, и две копии этих пяти шагов
 * разъехались бы на первой же доработке. Отличий ровно три: откуда берутся
 * начальные значения, что делает шаг с базой (у новой кампании базы нет, у
 * существующей она уже лежит) и что написано на кнопке.
 */
export function CampaignFormModal({ campaign, onClose, onCreated }: Props) {
  const editing = campaign != null;
  const [loading, setLoading] = useState(editing);
  // Идущую и завершённую кампанию показываем, но не даём править: планировщик
  // материализует письма в очередь заранее, и правка на ходу догнала бы только
  // часть базы — с непонятной границей между старым и новым текстом.
  const [readOnly, setReadOnly] = useState(false);

  const [name, setName] = useState(campaign?.name ?? '');
  const [mailboxes, setMailboxes] = useState<PickedMailbox[]>(campaign?.mailboxes ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  // База получателей выбирается прямо в форме: раньше её можно было загрузить
  // только кнопкой в списке уже созданной кампании, и из формы было непонятно,
  // кому вообще уйдёт письмо.
  // Файл сразу разбирается на сервере (без записи): какие колонки нашлись и
  // какие переменные можно вставить в письмо. Файл без колонки почты не
  // принимается — такую базу некому отправлять.
  const [recipientsFile, setRecipientsFile] = useState<File | null>(null);
  const [fileColumns, setFileColumns] = useState<RecipientColumnsDto | null>(null);
  const [fileMode, setFileMode] = useState<'append' | 'replace'>('append');
  const [previewing, setPreviewing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Уже загруженная база кампании: сколько в ней получателей и какие
  // переменные из неё доступны письму, пока нового файла не выбрали.
  const [saved, setSaved] = useState<{ total: number; exact: boolean; columns: RecipientColumnsDto } | null>(
    null,
  );

  // Цепочка писем до пяти шагов. Движок (планировщик + очередь) многошаговость
  // умеет всегда: follow-up уходит ответом в тред первого письма с «Re:», шаг
  // без темы — норма. Форма раньше отправляла ровно один шаг.
  const [letters, setLetters] = useState<{ subject: string; body: string; delayHours: number }[]>([
    { subject: '', body: '', delayHours: 72 },
  ]);
  const MAX_LETTERS = 5;
  const [hourFrom, setHourFrom] = useState(campaign?.send_hour_from ?? 9);
  const [hourTo, setHourTo] = useState(campaign?.send_hour_to ?? 18);
  const [timezone, setTimezone] = useState(campaign?.timezone ?? 'Europe/Moscow');
  const [gapSeconds, setGapSeconds] = useState(180);
  const [gapJitterSeconds, setGapJitterSeconds] = useState(120);
  // Будни по умолчанию: холодная рассылка в выходные бьёт по ответам и по
  // репутации домена. Но это умолчание, а не запрет — день включается кнопкой.
  const [weekdays, setWeekdays] = useState<number[]>(campaign?.send_weekdays ?? [...WORKDAYS]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Предпросмотр на реальных получателях (задача 5.6) и разбивка ответов по
  // шагам цепочки (задача 6.4) — обе показываются в блоке письма.
  const [preview, setPreview] = useState<PreviewSampleDto[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [repliesByStep, setRepliesByStep] = useState<{ step: number; replied: number }[]>([]);

  const campaignId = campaign?.id;
  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      const details = await fetchCampaign(campaignId);
      setName(details.campaign.name);
      setMailboxes(details.mailboxes);
      setHourFrom(details.campaign.send_hour_from);
      setHourTo(details.campaign.send_hour_to);
      setWeekdays(details.campaign.send_weekdays ?? []);
      setTimezone(details.campaign.timezone);
      setGapSeconds(details.campaign.gap_seconds);
      setGapJitterSeconds(details.campaign.gap_jitter_seconds);
      if (details.steps.length) {
        setLetters(
          details.steps.map((step) => ({
            subject: step.subject,
            body: step.body,
            delayHours: step.delay_hours || 72,
          })),
        );
      }
      setSaved(details.recipients);
      setRepliesByStep(details.repliesByStep ?? []);
      setReadOnly(!details.editable);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить кампанию');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickFile = async (file: File) => {
    setRecipientsFile(null);
    setFileColumns(null);
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
        setFileColumns(res);
      }
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Не удалось прочитать файл');
    } finally {
      setPreviewing(false);
    }
  };

  const openFilePicker = (mode: 'append' | 'replace') => {
    setFileMode(mode);
    fileRef.current?.click();
  };

  // Подсказки и проверки письма идут по новому файлу, если он выбран, иначе по
  // уже загруженной базе: письмо всегда сверяется с тем, что реально уедет.
  const columns = fileColumns ?? saved?.columns ?? null;
  const countsExact = fileColumns ? true : (saved?.exact ?? true);
  // Переменные проверяются по всей цепочке: неизвестная в любом шаге — ошибка.
  const { unknownKeys } = letterIssues(letters.map((l) => `${l.subject}\n${l.body}`).join('\n\n'), '', columns);
  const baseReady = editing ? (saved?.total ?? 0) > 0 || recipientsFile != null : recipientsFile != null;

  const firstLetter = letters[0];
  const lettersDone = Boolean(firstLetter?.subject.trim() && firstLetter?.body.trim())
    && letters.slice(1).every((letter) => Boolean(letter.body.trim()))
    && unknownKeys.length === 0;

  /**
   * Готовность шагов — один список, из которого берутся и подсветка номера, и
   * запрет на сохранение, и подсказка внизу окна. Пока это жило в трёх местах,
   * «Создать кампанию» соглашалась на полупустую форму, а отказ прилетал уже
   * с сервера: «Выберите хотя бы один ящик» без указания, где этот шаг.
   */
  const steps = [
    { no: 1, title: 'название', done: Boolean(name.trim()) },
    { no: 2, title: 'база получателей', done: baseReady },
    { no: 3, title: 'ящики', done: mailboxes.length > 0 },
    { no: 4, title: 'письмо', done: lettersDone },
    { no: 5, title: 'дни отправки', done: weekdays.length > 0 },
  ];
  const missing = steps.filter((step) => !step.done);

  /** Загрузить выбранный файл в кампанию и рассказать, что получилось. */
  const sendFile = async (id: string) => {
    const res = await uploadRecipients(id, recipientsFile as File, fileMode);
    // Обрез молча подменял «в файле 50 000» на «загружено 20 000» — теперь об
    // этом прямо сказано, иначе оператор считает базу большей, чем она есть.
    const truncation = res.truncated != null && res.fileRows != null
      ? ` В файле было ${res.fileRows} строк — загружены первые ${res.truncated}, остальное не попало в кампанию.`
      : '';
    // Пустое первое письмо — отдельной строкой, а не «плохим адресом»: чинят
    // его в переменных письма или в колонках файла, а не в адресах.
    const emptyLetter = res.skippedEmptyLetter
      ? `${res.skippedEmptyLetter} с пустым первым письмом (пустая переменная в теме или тексте), `
      : '';
    return (
      `${res.replaced ? 'База заменена' : 'Получателей добавлено'}: ${res.imported}. `
      + `Пропущено: ${res.skippedInvalid} с плохим адресом, ${emptyLetter}${res.skippedDuplicates} дублей, `
      + `${res.skippedSuppressed} из стоп-листа.${truncation}`
    );
  };

  const create = async () => {
    let id: string;
    try {
      ({ id } = await createCampaign({
        name,
        mailboxIds: mailboxes.map((m) => m.id),
        steps: letters.map((letter, index) => ({
          delayHours: index === 0 ? 0 : letter.delayHours,
          subject: letter.subject,
          body: letter.body,
        })),
        timezone,
        sendHourFrom: hourFrom,
        sendHourTo: hourTo,
        sendWeekdays: weekdays,
        gapSeconds,
        gapJitterSeconds,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать кампанию');
      setSaving(false);
      return;
    }

    // Кампания уже создана — если база не легла, окно всё равно закрываем:
    // повторное «Создать» завело бы дубль. Базу тогда догружают из этого же
    // окна, открыв кампанию по названию.
    try {
      const summary = await sendFile(id);
      await onCreated({
        notice: `Кампания создана. ${summary} Это черновик: письма пойдут после кнопки «Запустить».`,
      });
    } catch (err) {
      await onCreated({
        error: `Кампания создана, но база не загрузилась: ${
          err instanceof Error ? err.message : 'ошибка'
        }. Откройте кампанию по названию и загрузите базу ещё раз.`,
      });
    }
    onClose();
  };

  const save = async () => {
    if (!campaignId) return;
    try {
      await updateCampaign(campaignId, {
        name,
        mailboxIds: mailboxes.map((m) => m.id),
        steps: letters.map((letter, index) => ({
          delayHours: index === 0 ? 0 : letter.delayHours,
          subject: letter.subject,
          body: letter.body,
        })),
        timezone,
        sendHourFrom: hourFrom,
        sendHourTo: hourTo,
        sendWeekdays: weekdays,
        gapSeconds,
        gapJitterSeconds,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить кампанию');
      setSaving(false);
      return;
    }

    // Файл грузится после настроек: если база не ляжет, изменённое письмо и
    // пул ящиков уже сохранены, и повторять всю форму не придётся.
    let summary = 'Кампания сохранена.';
    if (recipientsFile) {
      try {
        summary = `Кампания сохранена. ${await sendFile(campaignId)}`;
      } catch (err) {
        await onCreated({
          error: `Настройки сохранены, но база не загрузилась: ${
            err instanceof Error ? err.message : 'ошибка'
          }.`,
        });
        onClose();
        return;
      }
    }
    await onCreated({ notice: summary });
    onClose();
  };

  const submit = async () => {
    if (missing.length) {
      setError(`Заполните шаги: ${missing.map((step) => `${step.no} — ${step.title}`).join(', ')}`);
      return;
    }
    setSaving(true);
    setError(null);
    if (editing) await save();
    else await create();
  };

  const shown = mailboxes.slice(0, SHOWN_MAILBOXES);
  const rest = mailboxes.length - shown.length;
  const statusHint = campaign ? STATUS_HINT[campaign.status] : STATUS_HINT.draft;

  /**
   * Предпросмотр на реальных строках базы: файл — если выбран, иначе загруженная
   * база кампании. Показывает, что фактически уедет лиду, включая пустые
   * переменные — агрегат по колонкам этого не видит.
   */
  const runPreview = async () => {
    setPreviewBusy(true);
    setError(null);
    setPreview(null);
    try {
      const steps = letters.map((letter) => ({ subject: letter.subject, body: letter.body }));
      if (recipientsFile) {
        const res = await previewRecipients(recipientsFile, steps);
        if (res.samples?.length) setPreview(res.samples);
        else setError('Предпросмотр не собрался — проверьте, что в письмах есть текст');
      } else if (editing && (saved?.total ?? 0) > 0 && campaignId) {
        const res = await previewCampaignSteps(campaignId, steps);
        setPreview(res.samples);
      } else {
        setError('Для предпросмотра нужна база: выберите файл или откройте кампанию с загруженной базой');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось собрать предпросмотр');
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <>
      <SenderModal
        title={editing ? (readOnly ? 'Кампания' : 'Настройки кампании') : 'Новая кампания'}
        subtitle={
          editing ? statusHint : 'Одно письмо по загруженной базе с выбранных ящиков'
        }
        size="wide"
        onClose={onClose}
        footer={
          <>
            {/* Что мешает сохранить — видно сразу и всё время, а не после
                нажатия: полоса действий не прокручивается вместе с формой. */}
            {error ? (
              <span className="mr-auto text-sm text-red-600">{error}</span>
            ) : readOnly ? (
              <span className="mr-auto text-xs text-zinc-500">{statusHint}</span>
            ) : missing.length ? (
              <span className="mr-auto text-sm text-amber-600">
                Заполните шаги: {missing.map((step) => `${step.no} — ${step.title}`).join(', ')}
              </span>
            ) : (
              <span className="mr-auto text-xs text-zinc-500">{statusHint}</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
            >
              {readOnly ? 'Закрыть' : 'Отмена'}
            </button>
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={saving || loading || missing.length > 0}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {editing ? 'Сохранить' : 'Создать кампанию'}
              </button>
            )}
          </>
        }
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : (
          <div className="space-y-3">
            <Step no={1} title="Название кампании" done={steps[0].done}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={readOnly}
                placeholder="Например: клиники Москвы, сентябрь"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 disabled:bg-zinc-50"
              />
            </Step>

            <Step
              no={2}
              title="Кому отправлять"
              done={steps[1].done}
              hint={recipientsFile ? recipientsFile.name : undefined}
            >
              {/* У существующей кампании база уже лежит, и новый файл может
                  значить две разные вещи — поэтому две кнопки, а не одна.
                  Замена уносит только тех, кому ещё ничего не планировали:
                  переписки с теми, кто уже получил письмо, остаются. */}
              {saved && saved.total > 0 ? (
                <p className="mb-2 text-sm text-zinc-600">
                  Сейчас в базе: <span className="text-zinc-900">{saved.total}</span> получателей
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => openFilePicker('append')}
                  disabled={previewing || readOnly}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
                >
                  {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                  {previewing
                    ? 'Читаю файл…'
                    : saved && saved.total > 0
                      ? 'Добавить из файла'
                      : recipientsFile
                        ? 'Другой файл'
                        : 'Загрузить базу'}
                </button>
                {saved && saved.total > 0 ? (
                  <button
                    type="button"
                    onClick={() => openFilePicker('replace')}
                    disabled={previewing || readOnly}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
                  >
                    Заменить базу
                  </button>
                ) : null}
                <span className="text-sm text-zinc-500">
                  {recipientsFile
                    ? `${recipientsFile.name} — ${fileMode === 'replace' ? 'заменит базу' : 'добавится к базе'}`
                    : 'Файл не выбран'}
                </span>
              </div>

              {fileError ? <p className="mt-2 text-sm text-red-600">{fileError}</p> : null}

              {fileColumns ? (
                <div className="mt-3 space-y-1 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600">
                  <p>
                    <span className="text-zinc-900">{fileColumns.recipients}</span> получателей в файле
                    {fileColumns.invalid || fileColumns.duplicates
                      ? ` · пропустим ${fileColumns.invalid} с плохим адресом и ${fileColumns.duplicates} дублей`
                      : ''}
                    {' · '}стоп-лист проверим при загрузке
                  </p>
                  {fileColumns.truncated != null && fileColumns.fileRows != null ? (
                    <p className="text-amber-600">
                      В файле {fileColumns.fileRows} строк, прочитано {fileColumns.truncated} — дальше первых
                      {' '}20 000 кампания не возьмёт. Разбейте файл на части, если нужна вся база.
                    </p>
                  ) : null}
                  <p>
                    Почта — колонка «{fileColumns.emailHeader}»
                    {fileColumns.nameHeader
                      ? `, имя — «${fileColumns.nameHeader}»`
                      : '. Колонки с именем нет — {{name}} и {{first_name}} недоступны'}
                  </p>
                  {fileMode === 'replace' ? (
                    <p className="text-amber-600">
                      Замена: из кампании уйдут только те, кому ещё ничего не отправляли и не ставили в
                      очередь. Переписки останутся.
                    </p>
                  ) : null}
                </div>
              ) : saved && saved.total > 0 ? (
                <p className="mt-2 text-xs text-zinc-500">
                  Переменные письма (шаг 4) берутся из этой базы.
                  {saved.exact ? '' : ' Счётчики заполнения не показываем — база большая.'}
                </p>
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
                {readOnly ? null : (
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    {mailboxes.length ? 'Изменить' : 'Выбрать'}
                  </button>
                )}
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
              {editing && !readOnly ? (
                <p className="mt-2 text-xs text-zinc-500">
                  Убранный ящик освободит тех получателей, кому ещё не писали, — они уедут с других.
                  Начатые переписки останутся на своём ящике: менять отправителя посреди переписки нельзя.
                </p>
              ) : null}
            </Step>

            {letters.map((letter, index) => (
              <LetterStep
                key={index}
                no={4}
                done={Boolean((index === 0 ? letter.subject.trim() : true) && letter.body.trim())}
                title={index === 0 ? 'Первое письмо' : `Письмо ${index + 1}`}
                subject={letter.subject}
                body={letter.body}
                delayHours={index === 0 ? undefined : letter.delayHours}
                onDelayHours={index === 0 ? undefined : (value) => setLetters((prev) => prev.map((l, i) => (i === index ? { ...l, delayHours: value } : l)))}
                onRemove={index === 0 || readOnly ? undefined : () => setLetters((prev) => prev.filter((_, i) => i !== index))}
                onSubject={(value) => setLetters((prev) => prev.map((l, i) => (i === index ? { ...l, subject: value } : l)))}
                onBody={(value) => setLetters((prev) => prev.map((l, i) => (i === index ? { ...l, body: value } : l)))}
                columns={columns}
                countsExact={countsExact}
                disabled={readOnly}
                emptyHint={
                  editing
                    ? 'В кампании пока нет получателей — загрузите базу (шаг 2), и здесь появятся её переменные.'
                    : 'Загрузите базу (шаг 2) — здесь появятся переменные из её колонок.'
                }
              />
            ))}

            {/* Добавить follow-up можно только при правке черновика/паузы: у
                идущей кампании письма уже материализованы в очередь. */}
            {!readOnly && letters.length < MAX_LETTERS ? (
              <button
                type="button"
                onClick={() => setLetters((prev) => [...prev, { subject: '', body: '', delayHours: 72 }])}
                className="w-full rounded-xl border border-dashed border-zinc-300 py-2.5 text-sm text-zinc-500 transition-colors hover:border-blue-400 hover:text-blue-600"
              >
                + Добавить письмо в цепочку ({letters.length} из {MAX_LETTERS})
              </button>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void runPreview()}
                disabled={previewBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
              >
                {previewBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Предпросмотр на реальных получателях
              </button>
              {/* На каком шаге лиды ответили — видно, работает ли цепочка дальше
                  первого касания (задача 6.4). */}
              {repliesByStep.length ? (
                <span className="text-xs text-zinc-500">
                  Ответили по шагам: {repliesByStep.map((r) => `${r.step} — ${r.replied}`).join(', ')}
                </span>
              ) : null}
            </div>

            <ScheduleStep
              no={5}
              done={steps[4].done}
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
              disabled={readOnly}
            />
          </div>
        )}
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

      {/* Предпросмотр поверх формы: сэмплы писем на реальных адресах базы. */}
      {preview ? (
        <SenderModal
          title="Предпросмотр письма"
          subtitle="Как письмо уйдёт реальным получателям базы (первые два адреса)"
          size="wide"
          onClose={() => setPreview(null)}
          footer={
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
            >
              Закрыть
            </button>
          }
        >
          <div className="space-y-4">
            {preview.map((sample) => (
              <div key={sample.email} className="rounded-xl border border-zinc-200 p-4">
                <p className="text-xs font-medium text-zinc-500">Получатель: {sample.email}</p>
                {sample.steps.map((step, index) => (
                  <div key={index} className="mt-2 border-t border-zinc-100 pt-2 first:border-0 first:pt-0">
                    <p className="text-sm font-medium text-zinc-900">{step.subject || 'Re: (в тот же тред)'}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-700">{step.body}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </SenderModal>
      ) : null}
    </>
  );
}
