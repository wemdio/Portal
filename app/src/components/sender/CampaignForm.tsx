'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileSpreadsheet, Loader2, Mail } from 'lucide-react';
import { applyVars, followUpSubject } from '@/lib/sender/template';
import { MIN_RECIPIENTS_PER_VARIANT, variantLabel } from '@/lib/sender/variants';
import {
  createCampaign,
  fetchCampaign,
  fetchTestLetter,
  previewCampaignSteps,
  previewRecipients,
  sendTestLetter,
  updateCampaign,
  uploadRecipients,
  type CampaignDto,
  type PreviewSampleDto,
  type RecipientColumnsDto,
  type VariantStatDto,
} from './api';
import { stashCampaignNotice, type CampaignNotice } from './campaignNotice';
import {
  LetterStep,
  ScheduleStep,
  Step,
  WORKDAYS,
  letterIssues,
  type LetterVariant,
} from './CampaignSteps';
import { LetterText } from './LetterLinks';
import { MailboxPickerModal, type PickedMailbox } from './MailboxPickerModal';
import { SenderModal } from './SenderModal';

/** Сколько адресов показываем в шаге выбора до того, как перейти на «и ещё N». */
const SHOWN_MAILBOXES = 8;
const MAX_LETTERS = 5;
/** Куда возвращаемся из настроек. */
const LIST_URL = '/tools/sender?tab=campaigns';
/** Пауза после последней правки, через которую новая кампания ляжет черновиком. */
const DRAFT_SAVE_DELAY_MS = 2000;

/** Куда положили адрес для тестового письма — его спрашивают в каждой кампании. */
const TEST_EMAIL_KEY = 'sender.testEmail';
/** Сколько ждём отправки теста: письмо уходит очередью воркера, не мгновенно. */
const TEST_WAIT_TRIES = 20;
const TEST_WAIT_MS = 3000;

/** Шаг цепочки в форме: варианты письма (А/Б-тест) и задержка от предыдущего. */
interface LetterStepState {
  variants: LetterVariant[];
  delayHours: number;
}

function emptyLetterStep(): LetterStepState {
  return { variants: [{ subject: '', body: '' }], delayHours: 72 };
}

/** Строки шагов из базы → шаги формы: варианты одного step_no в один шаг. */
function groupSteps(
  rows: { step_no: number; variant_no?: number; delay_hours: number; subject: string; body: string }[],
): LetterStepState[] {
  const byStep = new Map<number, LetterStepState>();
  for (const row of [...rows].sort((a, b) => a.step_no - b.step_no || (a.variant_no ?? 1) - (b.variant_no ?? 1))) {
    const step = byStep.get(row.step_no);
    const letter = { subject: row.subject, body: row.body };
    if (step) step.variants.push(letter);
    else byStep.set(row.step_no, { variants: [letter], delayHours: row.delay_hours || 72 });
  }
  return [...byStep.values()];
}

const STATUS_HINT: Record<CampaignDto['status'], string> = {
  draft: 'Черновик — письма пойдут только после «Запустить» в списке',
  paused: 'Кампания на паузе. Правки подействуют на тех, кому ещё не отправляли',
  running: 'Кампания идёт — чтобы править, поставьте её на паузу в списке',
  done: 'Кампания завершена — её можно только посмотреть',
};

/**
 * Настройки кампании «Рассылки» — отдельная страница, создание и правка одной
 * формой.
 *
 * Страница, а не окно поверх списка: в окне помещался один экран, письма
 * цепочки приходилось искать прокруткой, и в них нельзя было заглянуть
 * одновременно с базой и ящиками. Здесь слева то, что задаётся один раз
 * (название, база, ящики, расписание), справа — письма во всю ширину: именно
 * их правят чаще всего и сверяют друг с другом.
 *
 * Форма одна намеренно — набор решений у создания и у правки совпадает.
 * Отличий ровно три: откуда берутся начальные значения, что делает шаг с базой
 * (у новой кампании базы нет, у существующей она уже лежит) и что написано на
 * кнопке.
 */
export function CampaignForm({ campaignId }: { campaignId?: string }) {
  const router = useRouter();
  const editing = campaignId != null;
  const [loading, setLoading] = useState(editing);
  /** Кампанию не удалось прочитать: сохранять поверх неё нельзя. */
  const [loadFailed, setLoadFailed] = useState(false);
  // Идущую и завершённую кампанию показываем, но не даём править: планировщик
  // материализует письма в очередь заранее, и правка на ходу догнала бы только
  // часть базы — с непонятной границей между старым и новым текстом.
  const [readOnly, setReadOnly] = useState(false);
  const [status, setStatus] = useState<CampaignDto['status']>('draft');

  const [name, setName] = useState('');
  const [mailboxes, setMailboxes] = useState<PickedMailbox[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
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

  // Цепочка писем до пяти шагов: follow-up уходит ответом в тред первого
  // письма с «Re:», шаг без темы — норма. У шага может быть несколько
  // вариантов письма — это А/Б-тест, база делится между ними поровну.
  const [letters, setLetters] = useState<LetterStepState[]>([emptyLetterStep()]);
  const [hourFrom, setHourFrom] = useState(9);
  const [hourTo, setHourTo] = useState(18);
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [gapSeconds, setGapSeconds] = useState(180);
  const [gapJitterSeconds, setGapJitterSeconds] = useState(120);
  // Будни по умолчанию: холодная рассылка в выходные бьёт по ответам и по
  // репутации домена. Но это умолчание, а не запрет — день включается кнопкой.
  const [weekdays, setWeekdays] = useState<number[]>([...WORKDAYS]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Новая кампания сохраняется черновиком сама, пока её пишут: закрыли вкладку
  // или ушли со страницы — написанное осталось в списке, а не пропало.
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  /**
   * Куда сохранять: открытая кампания или черновик, который заведёт первое
   * автосохранение. Ref, потому что его читает таймер.
   */
  const draftRef = useRef<string | null>(campaignId ?? null);
  /** Идущее сохранение: второй вызов ждёт его, а не заводит вторую кампанию. */
  const draftBusy = useRef<Promise<void> | null>(null);
  /** Снимок настроек, который уже сохранён: без изменений не сохраняем заново. */
  const savedSnapshot = useRef('');
  // Предпросмотр на реальных получателях (задача 5.6) и разбивка ответов по
  // шагам цепочки (задача 6.4) — обе про письма.
  const [preview, setPreview] = useState<PreviewSampleDto[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [repliesByStep, setRepliesByStep] = useState<{ step: number; replied: number }[]>([]);
  // Результаты А/Б-теста по вариантам писем; пусто — тестов не было.
  const [variantStats, setVariantStats] = useState<VariantStatDto[]>([]);
  // Тестовое письмо себе: адрес помним между кампаниями — проверяют на свой.
  const [testEmail, setTestEmail] = useState('');
  // Какое письмо цепочки отправить тестом: шаг и вариант А/Б-теста.
  const [testKey, setTestKey] = useState('0:0');
  const [testBusy, setTestBusy] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      setTestEmail(window.localStorage.getItem(TEST_EMAIL_KEY) ?? '');
    } catch {
      // Приватный режим браузера — просто спросим адрес заново.
    }
  }, []);

  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      const details = await fetchCampaign(campaignId);
      setName(details.campaign.name);
      setStatus(details.campaign.status);
      setMailboxes(details.mailboxes);
      setHourFrom(details.campaign.send_hour_from);
      setHourTo(details.campaign.send_hour_to);
      setWeekdays(details.campaign.send_weekdays ?? []);
      setTimezone(details.campaign.timezone);
      setGapSeconds(details.campaign.gap_seconds);
      setGapJitterSeconds(details.campaign.gap_jitter_seconds);
      if (details.steps.length) setLetters(groupSteps(details.steps));
      setSaved(details.recipients);
      setRepliesByStep(details.repliesByStep ?? []);
      setVariantStats(details.variantStats ?? []);
      setReadOnly(!details.editable);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить кампанию');
      // Кампания не прочиталась — автосохранению нельзя: пустая форма записала
      // бы поверх настоящих писем и ящиков.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Уйти в список: итог сохранения показывает уже он. */
  const leave = (result?: CampaignNotice, focusId?: string) => {
    if (result) stashCampaignNotice(result);
    router.push(focusId ? `${LIST_URL}&campaign=${focusId}` : LIST_URL);
  };

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
  // Переменные проверяются по всей цепочке и по всем вариантам: неизвестная в
  // любом письме — ошибка.
  const allLetters = letters.flatMap((step) => step.variants);
  const { unknownKeys } = letterIssues(
    allLetters.map((letter) => `${letter.subject}\n${letter.body}`).join('\n\n'),
    '',
    columns,
  );
  const baseReady = editing ? (saved?.total ?? 0) > 0 || recipientsFile != null : recipientsFile != null;

  // Первое письмо: тема и текст обязательны у каждого варианта — лид получит
  // один из них. У follow-up обязателен только текст.
  const lettersDone = Boolean(
    letters[0]?.variants.length
      && letters[0].variants.every((letter) => letter.subject.trim() && letter.body.trim())
      && letters.slice(1).every((step) => step.variants.every((letter) => letter.body.trim()))
      && unknownKeys.length === 0,
  );

  /**
   * Готовность шагов — один список, из которого берутся и подсветка номера, и
   * запрет на сохранение, и подсказка в шапке страницы.
   */
  const steps = [
    { no: 1, title: 'название', done: Boolean(name.trim()) },
    { no: 2, title: 'база получателей', done: baseReady },
    { no: 3, title: 'ящики', done: mailboxes.length > 0 },
    { no: 4, title: 'письмо', done: lettersDone },
    { no: 5, title: 'дни отправки', done: weekdays.length > 0 },
  ];
  const missing = steps.filter((step) => !step.done);

  /** Цепочка для сервера: шаг с вариантами письма и задержкой от предыдущего. */
  const stepsPayload = letters.map((step, index) => ({
    delayHours: index === 0 ? 0 : step.delayHours,
    variants: step.variants,
  }));

  /**
   * Настройки кампании одним куском — их же сохраняет автосохранение.
   *
   * Лежит в ref, потому что автосохранение запускается по таймеру: к моменту
   * срабатывания в замыкании оказались бы значения на момент последней правки,
   * а сохранить надо то, что в форме сейчас.
   */
  const campaignPayload = {
    name,
    mailboxIds: mailboxes.map((m) => m.id),
    steps: stepsPayload,
    timezone,
    sendHourFrom: hourFrom,
    sendHourTo: hourTo,
    sendWeekdays: weekdays,
    gapSeconds,
    gapJitterSeconds,
  };
  const payloadRef = useRef(campaignPayload);
  payloadRef.current = campaignPayload;
  // Снимок строкой: по нему автосохранение понимает, что менялось, и по нему
  // же заводится таймер — иначе он сбрасывался бы на каждую перерисовку.
  const payloadSnapshot = JSON.stringify(campaignPayload);

  // Что-то уже написали: пустую форму черновиком не заводим — иначе список
  // кампаний зарастёт пустышками от случайных заходов.
  const draftWorthSaving = Boolean(
    name.trim() || letters.some((step) => step.variants.some((v) => v.subject.trim() || v.body.trim())),
  );

  /**
   * Сохранить то, что сейчас в форме, не требуя полноты; возвращает id
   * кампании (новая заводится черновиком).
   *
   * Сервер принимает такое сохранение без проверок (partial): ни ящиков, ни
   * писем, ни темы в нём может ещё не быть. Уехать такая кампания всё равно не
   * может — «Запустить» проверяет всё заново.
   */
  const saveDraft = useCallback(async (): Promise<string | null> => {
    // Сохранение уже идёт — дожидаемся его. Без этого «выйти» в момент
    // автосохранения завёл бы вторую такую же кампанию.
    if (draftBusy.current) {
      await draftBusy.current;
      return draftRef.current;
    }
    const snapshot = JSON.stringify(payloadRef.current);
    if (snapshot === savedSnapshot.current) return draftRef.current;

    const run = (async () => {
      try {
        if (draftRef.current) {
          await updateCampaign(draftRef.current, { ...payloadRef.current, draft: true });
        } else {
          const { id } = await createCampaign({ ...payloadRef.current, draft: true });
          draftRef.current = id;
        }
        savedSnapshot.current = snapshot;
        setDraftSavedAt(new Date());
      } catch {
        // Автосохранение молчит: это фон, а не действие человека. Не вышло —
        // следующая правка попробует снова, а в шапке не появится «сохранён».
      }
    })();
    draftBusy.current = run;
    try {
      await run;
    } finally {
      draftBusy.current = null;
    }
    return draftRef.current;
  }, []);

  /**
   * Автосохранение: пауза после последней правки — сохранять на каждую букву
   * незачем, а ждать дольше значит рисковать написанным, если вкладку закроют.
   *
   * Работает и у новой кампании, и у правки черновика или кампании на паузе:
   * письмо, ящики и расписание пропадали одинаково, с какой стороны ни зайди.
   * Идущую и завершённую кампанию не трогаем — их и править нельзя.
   *
   * Первый проход только запоминает, что уже сохранено: без этого правка
   * кампании записала бы поверх неё пустую форму, пока та ещё грузится.
   */
  useEffect(() => {
    if (readOnly || loading || saving || loadFailed) return;
    if (!savedSnapshot.current) {
      savedSnapshot.current = payloadSnapshot;
      return;
    }
    if (!draftWorthSaving) return;
    const timer = window.setTimeout(() => void saveDraft(), DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [readOnly, loading, saving, loadFailed, draftWorthSaving, saveDraft, payloadSnapshot]);

  /**
   * Результаты А/Б показываем только по шагам, где вариантов правда несколько:
   * строка «вариант А» у обычного письма — шум.
   */
  const testedSteps = new Set(
    variantStats.filter((row) => row.variant > 1).map((row) => row.step),
  );
  const abResults = variantStats.filter((row) => testedSteps.has(row.step));

  /** Что можно отправить тестом: каждое письмо цепочки и каждый его вариант. */
  const testTargets = letters.flatMap((step, stepIndex) =>
    step.variants.map((letter, variantIndex) => ({
      key: `${stepIndex}:${variantIndex}`,
      stepIndex,
      letter,
      label:
        (stepIndex === 0 ? 'Первое письмо' : `Письмо ${stepIndex + 1}`)
        + (step.variants.length > 1 ? ` · вариант ${variantLabel(variantIndex + 1)}` : ''),
    })),
  );

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
      // Черновик этой же кампании мог уже завестись автосохранением — тогда
      // дописываем его, иначе в списке появилась бы вторая такая же. Сначала
      // дожидаемся автосохранения, если оно как раз идёт.
      await saveDraft();
      if (draftRef.current) {
        await updateCampaign(draftRef.current, campaignPayload);
        id = draftRef.current;
      } else {
        ({ id } = await createCampaign(campaignPayload));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать кампанию');
      setSaving(false);
      return;
    }

    // Кампания уже создана — если база не легла, со страницы всё равно уходим:
    // повторное «Создать» завело бы дубль. Базу тогда догружают из этой же
    // страницы, открыв кампанию по названию.
    try {
      const summary = await sendFile(id);
      leave(
        { notice: `Кампания создана. ${summary} Это черновик: письма пойдут после кнопки «Запустить».` },
        id,
      );
    } catch (err) {
      leave(
        {
          error: `Кампания создана, но база не загрузилась: ${
            err instanceof Error ? err.message : 'ошибка'
          }. Откройте кампанию по названию и загрузите базу ещё раз.`,
        },
        id,
      );
    }
  };

  const save = async () => {
    if (!campaignId) return;
    try {
      await updateCampaign(campaignId, campaignPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить кампанию');
      setSaving(false);
      return;
    }

    // Файл грузится после настроек: если база не ляжет, изменённое письмо и
    // пул ящиков уже сохранены, и повторять всю форму не придётся.
    if (recipientsFile) {
      try {
        leave({ notice: `Кампания сохранена. ${await sendFile(campaignId)}` }, campaignId);
      } catch (err) {
        leave(
          {
            error: `Настройки сохранены, но база не загрузилась: ${
              err instanceof Error ? err.message : 'ошибка'
            }.`,
          },
          campaignId,
        );
      }
      return;
    }
    leave({ notice: 'Кампания сохранена.' }, campaignId);
  };

  /**
   * Уйти со страницы, не запуская кампанию: написанное остаётся сохранённым —
   * и у новой кампании (черновиком в списке), и у открытой на правку.
   *
   * Базу докладываем здесь, а не автосохранением: файл грузится один раз и
   * целиком, повторять это каждые пару секунд незачем.
   */
  const closePage = async () => {
    if (readOnly || loadFailed || !draftWorthSaving) {
      leave();
      return;
    }
    setSaving(true);
    const id = await saveDraft();
    if (!id) {
      leave();
      return;
    }
    const saved = editing
      ? 'Изменения сохранены.'
      : 'Черновик сохранён — он в списке кампаний. Письма пойдут после «Запустить».';
    if (!recipientsFile) {
      leave({ notice: saved }, id);
      return;
    }
    try {
      leave({ notice: `${saved} ${await sendFile(id)}` }, id);
    } catch {
      leave(
        { notice: `${saved} База не загрузилась — откройте кампанию по названию и выберите файл ещё раз.` },
        id,
      );
    }
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
  const statusHint = editing ? STATUS_HINT[status] : STATUS_HINT.draft;

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
      const previewSteps = letters.map((step) => ({ variants: step.variants }));
      if (recipientsFile) {
        const res = await previewRecipients(recipientsFile, previewSteps);
        if (res.samples?.length) setPreview(res.samples);
        else setError('Предпросмотр не собрался — проверьте, что в письмах есть текст');
      } else if (editing && (saved?.total ?? 0) > 0 && campaignId) {
        const res = await previewCampaignSteps(campaignId, previewSteps);
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

  /**
   * Тестовое письмо на свой адрес: то самое письмо кампании, с подставленными
   * переменными — примерами из базы, с первого выбранного ящика.
   *
   * Уходит общей очередью воркера, поэтому не мгновенно: ждём результат и
   * показываем его, иначе непонятно, письмо ещё едет или уже не доедет.
   */
  const sendTest = async () => {
    const mailbox = mailboxes[0];
    const target = testTargets.find((item) => item.key === testKey) ?? testTargets[0];
    const letter = target?.letter;
    if (!mailbox || !letter?.body.trim()) {
      setError('Для теста нужны выбранный ящик (шаг 3) и текст письма (шаг 4)');
      return;
    }
    const to = testEmail.trim();
    if (!to) {
      setError('Укажите почту, на которую отправить тест');
      return;
    }

    setTestBusy(true);
    setTestNote(null);
    setError(null);
    try {
      // Переменные подставляем примерами из базы: пустые места в тесте выглядят
      // так же, как они уедут лиду.
      const vars: Record<string, string> = Object.fromEntries(
        (columns?.variables ?? []).map((v) => [v.key, v.sample ?? '']),
      );
      const firstSubject = applyVars(letters[0]?.variants[0]?.subject ?? '', vars);
      const subject = target.stepIndex === 0
        ? applyVars(letter.subject, vars)
        : followUpSubject(applyVars(letter.subject, vars), firstSubject);

      const { id } = await sendTestLetter({
        mailboxId: mailbox.id,
        to,
        subject,
        body: applyVars(letter.body, vars),
      });
      try {
        window.localStorage.setItem(TEST_EMAIL_KEY, to);
      } catch {
        // Приватный режим — адрес просто не запомнится.
      }
      setTestNote(`Письмо в очереди, уйдёт с ${mailbox.email}…`);

      for (let i = 0; i < TEST_WAIT_TRIES; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, TEST_WAIT_MS));
        const { test } = await fetchTestLetter(id);
        if (test.status === 'sent') {
          setTestNote(`Отправлено на ${to} — посмотрите почту, в том числе «Спам»`);
          return;
        }
        if (test.status === 'failed') {
          setTestNote(null);
          setError(`Тест не ушёл: ${test.error ?? 'ошибка отправки'}`);
          return;
        }
      }
      setTestNote('Письмо ещё в очереди — проверьте почту через пару минут');
    } catch (err) {
      setTestNote(null);
      setError(err instanceof Error ? err.message : 'Не удалось отправить тест');
    } finally {
      setTestBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px]">
      {/* Шапка не уезжает при прокрутке: что мешает сохранить и сама кнопка
          нужны из любого места длинной формы. */}
      <div className="sticky top-0 z-20 mb-4 rounded-xl border border-zinc-200 bg-white/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => void closePage()}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <ArrowLeft className="h-4 w-4" />
            Кампании
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-zinc-900">
              {editing ? (readOnly ? 'Кампания' : 'Настройки кампании') : 'Новая кампания'}
              {name.trim() ? <span className="text-zinc-400"> · {name}</span> : null}
            </h1>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {error ? (
              <span className="text-sm text-red-600">{error}</span>
            ) : missing.length && !readOnly ? (
              <span className="text-sm text-amber-600">
                Заполните шаги: {missing.map((step) => `${step.no} — ${step.title}`).join(', ')}
              </span>
            ) : (
              <span className="text-xs text-zinc-500">{statusHint}</span>
            )}
            {/* Дописывать за один раз не обязательно: форма сохраняется сама,
                и к кампании можно вернуться. */}
            {readOnly ? null : (
              <span className="text-xs text-zinc-500">
                {draftSavedAt
                  ? `Сохранено в ${draftSavedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                  : 'Сохраняется само'}
              </span>
            )}
            <button
              type="button"
              onClick={() => void closePage()}
              disabled={saving}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
            >
              {readOnly ? 'Закрыть' : 'Выйти'}
            </button>
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={saving || missing.length > 0}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {editing ? 'Сохранить' : 'Создать кампанию'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Две колонки: слева то, что задают один раз, справа письма — их правят
          чаще всего, и им нужна ширина. На узком экране всё встаёт в столбик. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
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
                Переменные письма берутся из этой базы.
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
              несколько адресов целиком и счётчик остальных. Сам выбор — в окне
              с поиском, иначе страница превращается в простыню из адресов. */}
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

        <div className="space-y-3">
          {letters.map((step, index) => (
            <LetterStep
              key={index}
              no={4}
              done={step.variants.every(
                (letter) => (index === 0 ? letter.subject.trim() : true) && letter.body.trim(),
              )}
              title={index === 0 ? 'Первое письмо' : `Письмо ${index + 1}`}
              variants={step.variants}
              rows={14}
              delayHours={index === 0 ? undefined : step.delayHours}
              onDelayHours={index === 0 ? undefined : (value) => setLetters((prev) => prev.map((l, i) => (i === index ? { ...l, delayHours: value } : l)))}
              onRemove={index === 0 || readOnly ? undefined : () => setLetters((prev) => prev.filter((_, i) => i !== index))}
              onVariant={(variantIndex, patch) =>
                setLetters((prev) =>
                  prev.map((l, i) =>
                    i === index
                      ? { ...l, variants: l.variants.map((v, vi) => (vi === variantIndex ? { ...v, ...patch } : v)) }
                      : l,
                  ),
                )
              }
              onAddVariant={() =>
                setLetters((prev) =>
                  prev.map((l, i) =>
                    // Новый вариант — копия первого: правят обычно пару фраз,
                    // а не пишут письмо заново.
                    i === index ? { ...l, variants: [...l.variants, { ...l.variants[0] }] } : l,
                  ),
                )
              }
              onRemoveVariant={
                step.variants.length > 1
                  ? (variantIndex) =>
                      setLetters((prev) =>
                        prev.map((l, i) =>
                          i === index ? { ...l, variants: l.variants.filter((_, vi) => vi !== variantIndex) } : l,
                        ),
                      )
                  : undefined
              }
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
              onClick={() => setLetters((prev) => [...prev, emptyLetterStep()])}
              className="w-full rounded-xl border border-dashed border-zinc-300 py-2.5 text-sm text-zinc-500 transition-colors hover:border-blue-400 hover:text-blue-600"
            >
              + Добавить письмо в цепочку ({letters.length} из {MAX_LETTERS})
            </button>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 p-4">
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

            {abResults.length ? (
              <div className="w-full border-t border-zinc-100 pt-3">
                <p className="mb-1.5 text-xs font-medium text-zinc-700">Результаты А/Б-теста</p>
                <table className="w-full text-xs text-zinc-600">
                  <thead className="text-zinc-400">
                    <tr>
                      <th className="py-1 text-left font-normal">Письмо</th>
                      <th className="py-1 text-right font-normal">Отправлено</th>
                      <th className="py-1 text-right font-normal">Ответили</th>
                      <th className="py-1 text-right font-normal">Доля ответов</th>
                    </tr>
                  </thead>
                  <tbody>
                    {abResults.map((row) => (
                      <tr key={`${row.step}:${row.variant}`} className="border-t border-zinc-100">
                        <td className="py-1">
                          {row.step === 1 ? 'Первое письмо' : `Письмо ${row.step}`} · вариант{' '}
                          {variantLabel(row.variant)}
                        </td>
                        <td className="py-1 text-right">{row.sent}</td>
                        <td className="py-1 text-right">{row.replied}</td>
                        <td className="py-1 text-right">
                          {row.sent ? `${((row.replied / row.sent) * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Главная ошибка в А/Б: объявить победителя на двух ответах. */}
                {abResults.some((row) => row.sent < MIN_RECIPIENTS_PER_VARIANT) ? (
                  <p className="mt-1.5 text-xs text-amber-600">
                    Писем ещё мало: пока на вариант не ушло хотя бы {MIN_RECIPIENTS_PER_VARIANT}, разница в
                    ответах — случайность, а не победа текста.
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Тест себе: предпросмотр показывает текст, а как письмо выглядит
                в почте — видно только из почты. */}
            <div className="flex w-full flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="Почта для теста"
                className="w-56 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-900"
              />
              {testTargets.length > 1 ? (
                <select
                  value={testKey}
                  onChange={(e) => setTestKey(e.target.value)}
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-900"
                >
                  {testTargets.map((target) => (
                    <option key={target.key} value={target.key}>
                      {target.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                onClick={() => void sendTest()}
                disabled={testBusy || !mailboxes.length || !testEmail.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
              >
                {testBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Отправить тест себе
              </button>
              <span className="text-xs text-zinc-500">
                {testNote ?? 'Уйдёт с первого выбранного ящика, переменные — примерами из базы'}
              </span>
            </div>
          </div>
        </div>
      </div>

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

      {/* Предпросмотр поверх страницы: сэмплы писем на реальных адресах базы. */}
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
                    <p className="text-sm font-medium text-zinc-900">
                      {step.subject || 'Re: (в тот же тред)'}
                      {/* При А/Б-тесте видно, какой вариант уедет этому адресу. */}
                      {step.variant ? (
                        <span className="ml-2 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-normal text-zinc-500">
                          вариант {step.variant}
                        </span>
                      ) : null}
                    </p>
                    {/* Ссылки под словом рисуем ссылками: разметку в поле письма
                        иначе не с чем сверить. */}
                    <LetterText
                      text={step.body}
                      className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-700"
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </SenderModal>
      ) : null}
    </div>
  );
}
