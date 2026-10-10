'use client';

/**
 * Шаг 1 «Brief» клиентского ENG-кабинета: карточки site_profile (что движок
 * понял с сайта), редактируемые offer/style/signature overrides (уточняют
 * генерацию писем), рамка ЦА клиента (brief.icp — указание EN-промпту гипотез,
 * lib/hypothesisEngine/icpFrame), настройка проекта «до N адресов одной
 * компании» и «Re-run research» с дедупом на бэкенде.
 *
 * Все три формы шага держат черновики поверх значений сервера
 * (useServerDrafts ниже): открываются с сохранённым, полл не трогает
 * набираемое, на сервер уходит только изменённое.
 *
 * «Re-run research» удаляет оплаченное: кластеризация пересобирает вертикали, и
 * каскадом уходят базы, шаблоны, цепочки писем, вокабуляры и досье вертикалей.
 * Поэтому роут отвечает 409 со списком последствий, экран показывает их в
 * диалоге и только после явного согласия повторяет запрос с confirm: true.
 * Запущенный проект и проект с идущей работой роут отклоняет и с
 * подтверждением — текст отказа приходит с сервера.
 *
 * Настройка живёт здесь, а не на шаге сборки баз: это ДЕФОЛТ ПРОЕКТА для всех
 * будущих сборок (на поставленной базе лимит уже проштампован), то есть тот же
 * уровень, что и остальные настройки проекта на этом шаге.
 */

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import {
  HE_ICP_ENTRY_MAX_CHARS,
  HE_ICP_LINE_MAX_CHARS,
  HE_ICP_LIST_MAX_ENTRIES,
  parseHeIcpFramePatch,
  readHeIcpFrame,
  type HeIcpField,
  type HeIcpFrameInputError,
} from '@/lib/hypothesisEngine/icpFrame';
import {
  EngPaidAccessError,
  patchEngProject,
  startEngResearch,
  type EngBriefPatch,
  type EngResearchRerunConsequences,
  type HeJobSummary,
} from './api-client';
import { EngPaidAccessNotice } from './EngPaidAccess';
import { EngBadge, EngCard, EngEyebrow, EngSpinner } from './ui';
import type { EngDetail } from './EngProjectWizard';

const RESEARCH_STAGES = ['site_profile', 'competitors', 'brand_cloud', 'hypotheses', 'evidence', 'clustering'];

/** Подписи полей site_profile (EN) в порядке показа. */
const PROFILE_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'company_name', label: 'Company' },
  { key: 'product_summary', label: 'Product' },
  { key: 'usp', label: 'USP' },
  { key: 'target_audience', label: 'Target audience' },
  { key: 'business_model', label: 'Business model' },
  { key: 'price_tier', label: 'Price tier' },
  { key: 'deal_cycle', label: 'Deal cycle' },
  { key: 'geo', label: 'Geo' },
  { key: 'current_clients', label: 'Current clients' },
  { key: 'cases', label: 'Cases' },
];

/**
 * Варианты «сколько адресов одной компании брать в работу». Список короткий
 * намеренно: роут принимает 1..100, но клиенту нужен выбор, а не поле ввода с
 * границами, которые он должен угадывать.
 */
const CONTACT_CAP_OPTIONS = [1, 2, 3, 5, 10];

/**
 * Что действует, пока клиент ничего не выбрал. Зеркалит
 * HE_MAX_EMAILS_PER_COMPANY_DEFAULT движка; импортировать константу нельзя —
 * модуль постановки сборки уехал бы в клиентский бандл вместе с именами таблиц
 * и логикой дедупа. Авторитет всё равно на сервере: пустая колонка = дефолт
 * движка, а сохранённый выбор уезжает числом.
 */
const CONTACT_CAP_DEFAULT = 5;

/**
 * Действующее значение из строки проекта. Тип `EngProject` (api-client) поле
 * пока не объявляет — читаем через unknown, а не расширяем чужой DTO.
 * Границы не проверяем: их держит check-ограничение колонки, здесь достаточно
 * «целое положительное», иначе показываем дефолт.
 */
function contactCapOf(project: unknown): number {
  const raw = (project as { max_emails_per_company?: unknown } | null)?.max_emails_per_company;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : CONTACT_CAP_DEFAULT;
}

/** «1 audience» / «3 audiences»; число — en-US. */
function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * Пункты диалога — только то, что в ответе роута не ноль. Каждый пункт правдив
 * для любого набора чисел:
 *  - аудитория — любая база, кроме упавшей без строк (её роут в счёт не берёт).
 *    Поэтому «audience», а не «collected audience»: в счёт входит и база, которая
 *    ещё собирается (у неё может быть 0 строк). Строки — в скобках и только
 *    ненулевые; `rows` — строки базы, то есть адреса, не компании, поэтому и
 *    подпись «rows»;
 *  - шаблоны, цепочки писем, вокабуляры и досье вертикалей — строки, которые
 *    удалит каскад кластеризации; цепочки, вокабуляры и досье роут считает без
 *    упавших (status 'failed'), а пишут их стадии сразу готовыми.
 */
function rerunConsequenceLines(c: EngResearchRerunConsequences): string[] {
  const lines: string[] = [];
  if (c.audiences > 0) {
    lines.push(
      `${plural(c.audiences, 'audience', 'audiences')}${c.rows > 0 ? ` (${plural(c.rows, 'row', 'rows')})` : ''}`,
    );
  }
  if (c.templates > 0) lines.push(plural(c.templates, 'letter template', 'letter templates'));
  if (c.letter_sequences > 0) {
    lines.push(`${plural(c.letter_sequences, 'letter sequence', 'letter sequences')} written for your verticals`);
  }
  if (c.vocabularies > 0) {
    lines.push(`${plural(c.vocabularies, 'targeting vocabulary', 'targeting vocabularies')} built for your verticals`);
  }
  if (c.dossiers > 0) {
    lines.push(`${plural(c.dossiers, 'market dossier', 'market dossiers')} built for your verticals`);
  }
  return lines;
}

function isResearchActive(jobs: HeJobSummary[]): boolean {
  return jobs.some(
    (j) => RESEARCH_STAGES.includes(j.stage) && (j.status === 'pending' || j.status === 'running'),
  );
}

/**
 * Подсказка у поля «Business description» — по тому, ЧТО именно вышло с сайтом.
 *
 * Два факта, не один. `site_unreachable` — сайт не открылся (домена нет в DNS
 * либо ни один адрес не отдал HTML): читать было нечего вообще, и описание
 * бизнеса здесь не «рекомендуем», а единственный способ доделать research —
 * стадия без него отказывает, и тот же экран показывает карточку отказа.
 * `site_thin` — сайт открылся, но текста мало (или это JS-заглушка); стадия
 * доработала, описание улучшает результат. Стадия ставит `site_thin` и в первом
 * случае тоже, поэтому порядок проверок именно такой, иначе мёртвый домен
 * рассказывал бы клиенту про «мало текста».
 *
 * Оба поля приходят БУЛЕВЫМИ из проекции кабинета (clientEngProjection):
 * служебная пометка стадии с русской причиной в кабинет не уезжает.
 *
 * ОБА ФАКТА — ПРО ПОСЛЕДНЮЮ ЗАПИСАННУЮ ПРОВЕРКУ САЙТА, А НЕ ПРО СЕЙЧАС. Стадия
 * пишет их ровно в двух местах: отказом «сайт не открылся» и финальной записью
 * удачного прогона. Прогон, который сайт открыл, но упал дальше (биллинг,
 * таймаут модели, отмена), не пишет ничего — пометка прошлого прогона остаётся.
 * Поэтому подсказка говорит в прошедшем времени и ставит условие: «нужно, если
 * сайт всё ещё не открывается». В настоящем времени («we could not open your
 * site») она была ложью рядом с карточкой биллинга, когда сайт уже ожил.
 */
function businessDescriptionHint(brief: Record<string, unknown>): string {
  if (brief.site_unreachable === true) {
    return ' — required while your site does not open: our last recorded check could not open it';
  }
  if (brief.site_thin === true) {
    return ' — recommended: our last recorded read of your site found very little text';
  }
  return '';
}

/** Поля overrides — ключи brief и тела PATCH. */
const OVERRIDE_FIELDS = ['business_override', 'offer_override', 'style_override', 'signature_override'] as const;
type OverrideField = (typeof OVERRIDE_FIELDS)[number];

/** Сохранённые overrides: нет ключа или не строка — ''. */
function overridesOf(brief: Record<string, unknown>): Record<OverrideField, string> {
  const out = {} as Record<OverrideField, string>;
  for (const field of OVERRIDE_FIELDS) {
    const value = brief[field];
    out[field] = typeof value === 'string' ? value : '';
  }
  return out;
}

/** Подполя рамки ЦА в форме: списки — textarea по пункту на строку. */
type IcpField = HeIcpField;

const ICP_LABELS: Record<IcpField, string> = {
  include: 'Target',
  exclude: 'Never target',
  size: 'Company size',
  geo: 'Geography',
};

/**
 * Сохранённая рамка как текст формы. Через тот же читатель, что у роута и
 * стадии: что бы ни пришло в brief.icp, форма показывает рамку нужной формы.
 */
function icpTextOf(brief: Record<string, unknown>): Record<IcpField, string> {
  const frame = readHeIcpFrame(brief.icp);
  return {
    include: frame ? frame.include.join('\n') : '',
    exclude: frame ? frame.exclude.join('\n') : '',
    size: frame?.size ?? '',
    geo: frame?.geo ?? '',
  };
}

/**
 * Отказ проверки формы — подписями полей с экрана. Проверка та же, что у
 * роута (parseHeIcpFramePatch), поэтому до сервера доходит только то, что он
 * примет. `bad_shape`/`bad_type` из формы недостижимы: она шлёт строки и
 * только изменённые подполя, а пустой правки не шлёт вовсе.
 */
function icpErrorText(err: HeIcpFrameInputError): string {
  switch (err.code) {
    case 'too_many':
      return `${ICP_LABELS[err.field]}: up to ${err.max} lines.`;
    case 'too_long':
      return err.field === 'include' || err.field === 'exclude'
        ? `${ICP_LABELS[err.field]}: each line can be up to ${err.max} characters.`
        : `${ICP_LABELS[err.field]}: up to ${err.max} characters.`;
    default:
      return 'The target audience could not be saved.';
  }
}

/**
 * Поля формы поверх значений сервера.
 *
 * Было: overrides стартовали пустыми (форма открывалась без сохранённого),
 * полл с новым updated_at перезаписывал их значениями сервера (стирая
 * набираемое), а «Save» слал все четыре поля — и поле, оставшееся пустым,
 * удаляло сохранённый override (projectBriefPatch: пустая строка = удалить).
 *
 * Стало: `base` — последнее известное значение сервера (на монтировании — из
 * деталки, дальше — из каждой деталки с изменившимися значениями и из ответа
 * PATCH); `drafts` — то, что клиент правил, и наличие ключа там и есть флаг
 * «поле тронуто». На экране черновик, если он есть, иначе base: полл меняет
 * только нетронутые поля. Изменённое поле — черновик, отличный от base; на
 * сервер уходят только такие.
 *
 * Деталку сверяем по значениям, а не по updated_at: запись брифа
 * (patchHeProjectBrief) updated_at не трогает, и чужая правка тех же полей
 * (вторая вкладка, сотрудник) по нему не видна вовсе.
 */
function useServerDrafts<K extends string>(server: Record<K, string>) {
  const serverKey = JSON.stringify(server);
  const [seenKey, setSeenKey] = useState(serverKey);
  const [base, setBase] = useState(server);
  const [drafts, setDrafts] = useState<Partial<Record<K, string>>>({});
  // Правка state при смене пропа во время рендера (как было здесь же и в
  // client/layout) — без set-state-in-effect.
  if (serverKey !== seenKey) {
    setSeenKey(serverKey);
    setBase(server);
    // Сервер догнал черновик (то же сохранили из другой вкладки, сотрудник,
    // или деталка принесла наше же сохранение) — черновик снимается, как при
    // «вернул к сохранённому» ниже. Иначе он оставался бы скрытым (равен base —
    // поле не считается изменённым), а после следующей правки того же поля на
    // сервере экран показал бы этот старый черновик вместо нового значения, и
    // «Save» записал бы его обратно.
    setDrafts((current) => {
      let next: Partial<Record<K, string>> | null = null;
      for (const key of Object.keys(current) as K[]) {
        if (current[key] === server[key]) {
          next ??= { ...current };
          delete next[key];
        }
      }
      return next ?? current;
    });
  }
  const keys = Object.keys(server) as K[];
  const value = (key: K): string => drafts[key] ?? base[key];
  const changed = keys.filter((key) => drafts[key] !== undefined && drafts[key] !== base[key]);
  // Вернул поле к сохранённому — черновик снимается: иначе поле осталось бы
  // «тронутым», и чужая правка того же поля с сервера на экран не попала бы.
  const edit = (key: K, next: string) =>
    setDrafts((current) => {
      const copy = { ...current };
      if (next === base[key]) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  /**
   * Сохранено. base — то, что записал сервер (ответ PATCH, после его чистки);
   * без значений в ответе — то, что отправили. Черновик снимается, только если
   * его не правили, пока запрос шёл: иначе набранное за это время пропало бы.
   */
  const saved = (stored: Record<K, string> | null, sent: Partial<Record<K, string>>) => {
    setBase((current) => stored ?? { ...current, ...sent });
    setDrafts((current) => {
      const copy = { ...current };
      for (const key of Object.keys(sent) as K[]) {
        if (copy[key] === sent[key]) delete copy[key];
      }
      return copy;
    });
  };
  return { value, changed, edit, saved };
}

/**
 * Подпись рядом с кнопкой сохранения. Состояния: идёт сохранение — пусто
 * (спиннер на кнопке); есть несохранённые правки — «Unsaved changes» (в том
 * числе после удачного сохранения: значит, правили снова); сохраняли и правок
 * нет — «Saved»; иначе пусто.
 */
function SaveStatus({ saving, savedAt, unsaved }: { saving: boolean; savedAt: number; unsaved: boolean }) {
  if (saving) return null;
  if (unsaved) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--cp-amber)' }}>
        Unsaved changes
      </span>
    );
  }
  if (savedAt > 0) {
    return (
      <span className="text-[11px]" style={{ color: 'var(--cp-green)' }}>
        Saved
      </span>
    );
  }
  return null;
}

/** Значение поля site_profile → строка (массивы — списком через точку с запятой). */
function profileValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('; ');
  }
  if (typeof value === 'string') return value;
  return '';
}

export function EngStepBrief({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const { project, jobs = [] } = detail;
  const brief = (project.brief ?? {}) as Record<string, unknown>;
  const siteProfile = (brief.site_profile ?? null) as Record<string, unknown> | null;
  const businessHint = businessDescriptionHint(brief);

  const overrides = useServerDrafts(overridesOf(brief));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const icp = useServerDrafts(icpTextOf(brief));
  const [icpSaving, setIcpSaving] = useState(false);
  const [icpSavedAt, setIcpSavedAt] = useState(0);
  const [researchBusy, setResearchBusy] = useState(false);
  // Открытый диалог подтверждения повторного исследования (null — закрыт).
  const [rerunConfirm, setRerunConfirm] = useState<EngResearchRerunConsequences | null>(null);
  const [error, setError] = useState('');
  /** Отказ гейта платных шагов на «Re-run research» — с действием. */
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);
  // Селект настройки — та же схема черновика. Пустого значения у него нет:
  // база — действующее число (пустая колонка проекта = дефолт движка).
  const capForm = useServerDrafts({ cap: String(contactCapOf(project)) });
  const cap = Number(capForm.value('cap'));
  const [capSaving, setCapSaving] = useState(false);
  const [capSavedAt, setCapSavedAt] = useState(0);

  const researchActive = useMemo(() => isResearchActive(jobs), [jobs]);

  // Значение, выставленное вне этого селекта (поддержка попросила 7), обязано
  // остаться видимым: иначе экран показывал бы не то, что действует.
  const capOptions = useMemo(
    () => (CONTACT_CAP_OPTIONS.includes(cap) ? CONTACT_CAP_OPTIONS : [...CONTACT_CAP_OPTIONS, cap].sort((a, b) => a - b)),
    [cap],
  );

  // Обе карточки пишут один jsonb brief, а роут делает read-merge-write без
  // сверки версии (patchHeProjectBrief): два запроса в полёте читают один и тот
  // же brief, и записанный последним возвращает поле первого к прежнему
  // значению. Поэтому, пока идёт одно сохранение брифа, второе не уходит.
  const briefSaving = saving || icpSaving;

  // Только изменённые поля: присланное роут перезаписывает (пустое — удаляет),
  // неприсланное не трогает.
  const onSave = async () => {
    if (briefSaving || overrides.changed.length === 0) return;
    const sent: Partial<Record<OverrideField, string>> = {};
    for (const field of overrides.changed) sent[field] = overrides.value(field);
    setSaving(true);
    setError('');
    try {
      const res = await patchEngProject(project.id, sent);
      const storedBrief = res?.project?.brief;
      overrides.saved(storedBrief ? overridesOf(storedBrief as Record<string, unknown>) : null, sent);
      setSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Рамка ЦА: только изменённые подполя (роут сливает их с сохранённой
  // рамкой), проверка — та же, что у роута, до отправки.
  const onSaveIcp = async () => {
    if (briefSaving || icp.changed.length === 0) return;
    const sent: Partial<Record<IcpField, string>> = {};
    const patch: NonNullable<EngBriefPatch['icp']> = {};
    for (const field of icp.changed) {
      const text = icp.value(field);
      sent[field] = text;
      if (field === 'include' || field === 'exclude') patch[field] = text.split('\n');
      else patch[field] = text;
    }
    const checked = parseHeIcpFramePatch(patch);
    if (!checked.ok) {
      setError(icpErrorText(checked.error));
      return;
    }
    setIcpSaving(true);
    setError('');
    try {
      const res = await patchEngProject(project.id, { icp: patch });
      const storedBrief = res?.project?.brief;
      icp.saved(storedBrief ? icpTextOf(storedBrief as Record<string, unknown>) : null, sent);
      setIcpSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setIcpSaving(false);
    }
  };

  const onSaveCap = async () => {
    if (capSaving) return;
    const sentCap = capForm.value('cap');
    setCapSaving(true);
    setError('');
    try {
      // Тело PATCH в api-client объявлено только полями брифа — расширяем тип
      // на месте вызова, чтобы не править общий модуль чужой полосы (см.
      // handoff в отчёте). На провод уезжает { max_emails_per_company: <число> }.
      const body: Parameters<typeof patchEngProject>[1] & { max_emails_per_company: number } = {
        max_emails_per_company: Number(sentCap),
      };
      const saved = await patchEngProject(project.id, body);
      // Показываем то, что БД действительно сохранила (ответ идёт через ту же
      // клиентскую проекцию, что и деталка), не дожидаясь перечитывания деталки.
      capForm.saved(saved?.project ? { cap: String(contactCapOf(saved.project)) } : null, { cap: sentCap });
      setCapSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setCapSaving(false);
    }
  };

  // Первый клик идёт БЕЗ подтверждения: если удалять нечего, исследование
  // просто стартует. Если есть — сервер отвечает 409 с последствиями, и
  // открывается диалог; confirm: true уходит только из его кнопки.
  const onResearch = async (confirmed: boolean) => {
    if (researchBusy || researchActive) return;
    setResearchBusy(true);
    setError('');
    setRefusal(null);
    try {
      const res = await startEngResearch(project.id, confirmed ? { confirm: true } : undefined);
      if (res.kind === 'confirm_required') {
        setRerunConfirm(res.consequences);
        return;
      }
      setRerunConfirm(null);
      onChanged();
    } catch (e) {
      setRerunConfirm(null);
      if (e instanceof EngPaidAccessError) setRefusal(e);
      else setError(e instanceof Error ? e.message : 'Failed to start research');
    } finally {
      setResearchBusy(false);
    }
  };

  // Escape закрывает диалог, как и клик по подложке.
  useEffect(() => {
    if (!rerunConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRerunConfirm(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rerunConfirm]);

  return (
    <div className="flex flex-col gap-4">
      <EngCard>
        <div className="flex items-center gap-2">
          <EngEyebrow>Site profile</EngEyebrow>
          <span className="mb-2">
            {researchActive ? (
              <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
                <EngSpinner className="h-3 w-3" /> research in progress…
              </span>
            ) : (
              <EngBadge label={project.status} tone={project.status === 'researched' ? 'green' : 'neutral'} />
            )}
          </span>
          <button
            type="button"
            onClick={() => void onResearch(false)}
            disabled={researchBusy || researchActive}
            className="ds-btn-ghost ml-auto mb-2 inline-flex items-center gap-1.5 text-[11px]"
          >
            {researchBusy ? <EngSpinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
            Re-run research
          </button>
        </div>

        {siteProfile ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            {PROFILE_FIELDS.map(({ key, label }) => {
              const value = profileValue(siteProfile[key]);
              if (!value) return null;
              return (
                <div
                  key={key}
                  className="rounded-md p-3"
                  style={{ border: '1px solid var(--cp-divider)' }}
                >
                  <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--cp-text-l)' }}>
                    {label}
                  </dt>
                  <dd className="mt-1 text-sm whitespace-pre-wrap" style={{ color: 'var(--cp-paper)' }}>
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            {researchActive
              ? 'Profiling the site — the brief will appear here as soon as the research finishes.'
              : 'No site profile yet. Run the research to build it from your website.'}
          </p>
        )}
      </EngCard>

      <EngCard>
        <EngEyebrow>Offer &amp; style overrides</EngEyebrow>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          These notes steer letter generation. Leave empty to use what the research inferred.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: businessHint ? 'var(--cp-amber)' : 'var(--cp-text-m)' }}>
              Business description (manual, max 3000 chars)
              {businessHint}
            </span>
            <textarea
              value={overrides.value('business_override')}
              onChange={(e) => overrides.edit('business_override', e.target.value)}
              rows={4}
              maxLength={3000}
              placeholder="What you sell, to whom, and why clients pick you. Used above the site profile when the site is thin, JS-heavy, or could not be opened at all."
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Offer override
            </span>
            <textarea
              value={overrides.value('offer_override')}
              onChange={(e) => overrides.edit('offer_override', e.target.value)}
              rows={2}
              placeholder="e.g. 4–6 qualified meetings per month with US clinic owners, pay-per-meeting"
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Style reference (1–2 “perfect” emails to imitate)
            </span>
            <textarea
              value={overrides.value('style_override')}
              onChange={(e) => overrides.edit('style_override', e.target.value)}
              rows={4}
              placeholder="Paste an email whose tone the generator should copy"
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Sender signature (used verbatim at the end of every letter)
            </span>
            <textarea
              value={overrides.value('signature_override')}
              onChange={(e) => overrides.edit('signature_override', e.target.value)}
              rows={2}
              placeholder="Jane Doe, Acme, acme.com"
              className="ds-input w-full resize-y"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={briefSaving || overrides.changed.length === 0}
              className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
            >
              {saving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
              Save overrides
            </button>
            <SaveStatus saving={saving} savedAt={savedAt} unsaved={overrides.changed.length > 0} />
          </div>
        </div>
      </EngCard>

      {/* Рамка ЦА читается только EN-промптом гипотез (рынок us); роут на
          другом рынке её не принимает, поэтому и формы там нет. */}
      {project.market === 'us' && (
        <EngCard>
          <EngEyebrow>Target audience</EngEyebrow>
          {/* Каждая фраза — про механизм как он есть. Рамку читает только
              стадия гипотез, в начале своего прогона (stages/hypotheses.ts,
              EN-промпт prompts/hypotheses.en.ts): по ней модель выбирает и
              запрещает сегменты (шаг 2). Размер и география — указание модели
              вписать их условием отбора в описание каждой гипотезы внутри
              рамки; описания читает планировщик источников
              (prompts/sourcePlan.en.ts: фильтры стран и штата), а порог штата
              из плана, когда размер в них не назван, сборка снимает (кроме
              среза, у которого без него не осталось бы других фильтров —
              heSizeBasisEn и heTaskWithoutUnfoundedSize, stages/baseCollect.ts). Вписывает их модель, кодом гипотеза с
              рамкой не сверяется, отсюда «usually». География — уже, чем
              размер: pdl, funded и eng_hiring фильтруют только по СТРАНЕ, место
              мельче страны (штат, регион, город) несёт лишь гео запроса
              google_maps, а релевант-гейт географию не проверяет вовсе. Поэтому
              про страну — «usually … a filter», про штат/город — только карты и
              честное «companies from elsewhere can still appear». Сохранённое
              после старта стадии войдёт в следующий прогон research. */}
          <p className="mb-3 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            Who the research should aim at. These answers steer which market hypotheses the research
            proposes. The company size you name here usually becomes a condition for which companies are
            collected for those hypotheses. A country usually becomes a filter for the companies collected,
            while a state, region or city can be used only when searching local businesses on maps, so
            companies from elsewhere can still appear. The research reads these answers when it drafts the
            hypotheses, so answers saved after that apply the next time it runs.
          </p>
          <div className="flex flex-col gap-3">
            {(['include', 'exclude'] as const).map((field) => (
              <label key={field} className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
                  {ICP_LABELS[field]} (one per line, up to {HE_ICP_LIST_MAX_ENTRIES} lines of{' '}
                  {HE_ICP_ENTRY_MAX_CHARS} characters)
                </span>
                <textarea
                  value={icp.value(field)}
                  onChange={(e) => icp.edit(field, e.target.value)}
                  rows={3}
                  placeholder={
                    field === 'include'
                      ? 'e.g. Multi-location dental groups\nIndependent orthodontic practices'
                      : 'e.g. Hospitals\nDental schools'
                  }
                  className="ds-input w-full resize-y"
                />
              </label>
            ))}
            <div className="grid gap-3 sm:grid-cols-2">
              {(['size', 'geo'] as const).map((field) => (
                <label key={field} className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
                    {ICP_LABELS[field]}
                  </span>
                  <input
                    type="text"
                    value={icp.value(field)}
                    onChange={(e) => icp.edit(field, e.target.value)}
                    maxLength={HE_ICP_LINE_MAX_CHARS}
                    placeholder={field === 'size' ? 'e.g. 20–500 employees' : 'e.g. Texas and Florida'}
                    className="ds-input w-full"
                  />
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onSaveIcp()}
                disabled={briefSaving || icp.changed.length === 0}
                className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
              >
                {icpSaving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                Save target audience
              </button>
              <SaveStatus saving={icpSaving} savedAt={icpSavedAt} unsaved={icp.changed.length > 0} />
            </div>
          </div>
        </EngCard>
      )}

      <EngCard>
        <EngEyebrow>Contacts per company</EngEyebrow>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          The most people we may write to at one company. Applies to lists collected from now on —
          a list you have already collected keeps the number it was collected with.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
            Email addresses per company
            <select
              value={cap}
              onChange={(e) => capForm.edit('cap', e.target.value)}
              className="ds-input mt-1 w-full text-xs"
            >
              {capOptions.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'Up to 1 address' : `Up to ${n} addresses`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void onSaveCap()}
            disabled={capSaving}
            className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
          >
            {capSaving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
            Save
          </button>
          <SaveStatus saving={capSaving} savedAt={capSavedAt} unsaved={capForm.changed.length > 0} />
        </div>
      </EngCard>

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
      {refusal && <EngPaidAccessNotice refusal={refusal} />}

      {rerunConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="eng-rerun-research-title"
          onClick={() => setRerunConfirm(null)}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ds-card w-full max-w-md p-5"
            style={{ background: 'var(--cp-surface-elev)' }}
          >
            <h2 id="eng-rerun-research-title" className="text-base font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
              Re-run research?
            </h2>
            {/* «When the new research finishes»: удаляет последняя стадия
                (кластеризация); исследование, упавшее раньше неё, ничего не
                удалит, поэтому безусловное «is deleted» было бы неправдой. */}
            <p className="text-sm mb-2" style={{ color: 'var(--cp-text-m)' }}>
              When the new research finishes, it rebuilds the verticals of this project from scratch and
              deletes everything built on the current ones. This cannot be undone.
            </p>
            {rerunConsequenceLines(rerunConfirm).length > 0 && (
              <>
                <p className="text-sm mb-1" style={{ color: 'var(--cp-text-m)' }}>
                  Built on the current verticals now:
                </p>
                <ul className="mb-3 list-disc pl-5 text-sm" style={{ color: 'var(--cp-paper)' }}>
                  {rerunConsequenceLines(rerunConfirm).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-[11px] mb-4" style={{ color: 'var(--cp-text-l)' }}>
              The verticals themselves come from the new research, so they may differ from the ones you see
              now.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void onResearch(true)}
                disabled={researchBusy}
                className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
                style={{ background: 'var(--cp-red)' }}
              >
                {researchBusy ? <EngSpinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
                Delete and re-run research
              </button>
              <button
                type="button"
                onClick={() => setRerunConfirm(null)}
                disabled={researchBusy}
                className="ds-btn-ghost text-xs"
              >
                Keep everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
