/**
 * «Последняя миля» мастера «Движка вертикалей»: подготовка данных для
 * отправки готового шаблона (шаг 5) в запуск — создание PAUSED-кампании
 * в Instantly с лидами базы и цепочкой шаблона.
 *
 * Модуль ЧИСТЫЙ (без server-only/DB/фетчей): собирает sequence из писем
 * шаблона и маппит строки базы в лиды. HTTP-роут
 * (api/tools/hypothesis-engine/templates/[id]/launch) делает все вызовы
 * Instantly/Supabase сам, переиспользуя клиентский стек запуска:
 *   - buildCampaignPayloadFromPreset (delay-лесенка, HTML-обёртка, text_only,
 *     расписание/лимиты/трекинг из пресета);
 *   - instantly client createCampaign → (updateCampaign, если Instantly
 *     не принял sequences) → createLeads (чанкует по 1000 внутри);
 *   - activateCampaign НЕ вызывается никогда — сотрудник проверяет кампанию
 *     в Instantly и запускает вручную.
 *
 * Отличия от клиентского runLaunch осознанные:
 *   - нет тарифных гейтов и журнала client_campaign_launches (запуск делает
 *     сотрудник из внутреннего инструмента, billing клиента не должен
 *     меняться). ЧЁРНЫЙ СПИСОК клиента — не отличие: он применяется в обоих
 *     контурах, fail-closed, до первого вызова рассыльщика
 *     (launchTemplate.ts, шаг 5a). Блок ставит сам клиент по негативным
 *     ответам, и «письмо от сотрудника» для получателя ничем не отличается от
 *     письма из кабинета;
 *   - ТРЕБОВАНИЕ вердикта валидации (строка без вердикта не отправляется) и
 *     отказ от запуска легаси-базы — только у market='us'. В RU-инструменте
 *     эти строки уезжают как до 26.09.2026, но теперь названы в
 *     предупреждениях запуска: частично собранная база там штатный случай, и
 *     запрещать её сотруднику никто не просил (launchTemplate.ts, шаги 4c и 5);
 *   - пресет читается по id без client_user_id-скоупа (service-level read через
 *     тот же supabaseInstantly, что и clientLaunch);
 *   - ошибки НЕ проходят scrubBrand — текст идёт во внутренний UI, где точная
 *     формулировка Instantly важнее white-label.
 */

import type { LeadCreatePayload } from '@/lib/instantly/types';
import {
  CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP,
  type ClientLaunchSequenceStep,
} from '@/lib/clientLaunch/types';
import { extractEmails } from '@/lib/tools/dfybUtils';
// Только ТИП рынка: модуль обязан остаться чистым (его тянет и 'use client'
// шаг 5 staff-инструмента), а market.ts своих зависимостей не имеет вовсе.
import type { HeMarket } from './market';
import type { HeChainLetter, HeOperatorMapping } from './types';

/** Максимум лидов за один запуск из мастера (v1-ограничение роута, 413 сверх). */
export const HE_LAUNCH_MAX_LEADS = 2000;

/**
 * ОТКАЗЫВАЕТ ли запуск базе, в которой адресов больше HE_LAUNCH_MAX_LEADS.
 *
 * С 26.09.2026 ответ зависит от рынка ПРОЕКТА, а не от контура запуска:
 *   - market='us' — потолок ВЫБИРАЕТ адреса (selectLeadsWithinLaunchCap ниже),
 *     и такая база запускается: сначала по одному сильнейшему адресу каждой
 *     компании, потом вторые. Отказа нет;
 *   - market='ru' — запуск отвечает 413, как и раньше: там строка = компания
 *     (шага split_emails в RU-списке нет), и резать оплаченный срез никто не
 *     просил.
 *
 * Функция существует, чтобы это правило было ОДНО. По нему разветвляется и сам
 * запуск (launchTemplate.ts, шаг 5b), и пречек staff-шага 5, который гасит
 * кнопку «Отправить в запуск» по row_count базы (Step5Template.tsx): пречек,
 * выведенный отдельно, уже разошёлся с запуском и запрещает сотруднику запуск
 * us-базы, которой запуск ничего не отказывает.
 */
export function heLaunchRefusesOverCap(market: HeMarket): boolean {
  return market !== 'us';
}

/**
 * Кампания одного сегмента в записи о запуске. При материализации сегментных
 * вариантов запуск создаёт НЕСКОЛЬКО paused-кампаний: по одной на сегмент +
 * основная (segment=null, дефолтные тексты).
 */
export interface HeTemplateLaunchCampaign {
  campaign_id: string;
  campaign_name: string;
  campaign_url: string;
  /** Условие сегмента (when дословно); null — основная кампания. */
  segment: string | null;
  /** ПРИНЯТЫХ рассыльщиком адресов (leads_uploaded его ответа). */
  leads_count: number;
  /**
   * Сколько адресов ушло в запросе (`leads_requested`) и сколько рассыльщик
   * признал полученными (`total_sent` его ответа).
   *
   * Зачем рядом с leads_count: принятых он и так хранит, а ЗАПРОШЕННЫХ до
   * 28.09.2026 не хранил никто — молчаливая частичная загрузка была
   * неотличима от «столько адресов в базе и было». Остаток
   * `leads_requested - leads_count` — ПОВТОРЯЕМЫЙ: ни одна строка базы при
   * запуске не помечается отправленной (запуск в he_bases не пишет вовсе).
   *
   * Ключей нет у записей до 28.09.2026 и у кампании, чью загрузку прервала
   * ошибка: тогда принято неизвестно сколько, и такой сегмент попадает в
   * `pending` вместо того, чтобы врать числом.
   */
  leads_requested?: number;
  leads_attempted?: number;
}

/**
 * Сегмент запуска, который НЕ ПОЕХАЛ: кампании нет вовсе либо она создана, но
 * лиды в неё не загрузились.
 *
 * Зачем в записи о запуске: по этому списку ПОВТОР понимает, что запуск не
 * закончен, и достраивает именно недостающее, вместо того чтобы создать
 * каждому сегменту вторую одноимённую кампанию (launchTemplate.ts, шаг 6).
 * Пустой массив не пишется — ключа нет, и запись без него означает «запуск
 * закончен» (так же читаются все записи до 28.09.2026).
 */
export interface HeTemplateLaunchPending {
  /** Условие сегмента (when дословно); null — основная кампания. */
  segment: string | null;
  /** Где остановились: кампании нет / есть, но лиды не загружены. */
  stage: 'campaign' | 'leads';
}

/**
 * Запись о запуске, сохраняемая в `he_templates.launch_info` (jsonb).
 * NB: колонка появляется отдельной миграцией — до неё роут создаёт кампанию,
 * но предупреждает, что запись не сохранилась.
 * Скалярные поля (campaign_id и т.п.) — всегда про ОСНОВНУЮ кампанию
 * (обратная совместимость: долив refill и старый UI читают только их).
 */
export interface HeTemplateLaunchInfo {
  campaign_id: string;
  campaign_name: string;
  campaign_url: string;
  leads_count: number;
  preset_id: string;
  created_at: string;
  /** Все кампании запуска (основная + сегментные). Поля нет у запусков до сплита. */
  campaigns?: HeTemplateLaunchCampaign[];
  /** Суммы по кампаниям: запрошено и признано полученным (см. кампанию выше). */
  leads_requested?: number;
  leads_attempted?: number;
  /** Сегменты, которые не поехали; ключа нет — запуск закончен. */
  pending?: HeTemplateLaunchPending[];
}

/** Пункт селектора пресетов (GET launch): id + человекочитаемое имя клиента. */
export interface HeLaunchPresetOption {
  id: string;
  name: string;
}

/** Неотрицательное целое из jsonb; всё остальное — «ключа нет» (undefined). */
function optionalCount(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/** Аккуратно прочитать launch_info из jsonb (могло прийти что угодно). */
export function parseLaunchInfo(raw: unknown): HeTemplateLaunchInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.campaign_id !== 'string' || r.campaign_id.length === 0) return null;
  const campaigns = Array.isArray(r.campaigns)
    ? (r.campaigns as Array<Record<string, unknown>>)
        .filter((c) => c && typeof c.campaign_id === 'string' && c.campaign_id.length > 0)
        .map((c) => {
          const requested = optionalCount(c.leads_requested);
          const attempted = optionalCount(c.leads_attempted);
          return {
            campaign_id: c.campaign_id as string,
            campaign_name: typeof c.campaign_name === 'string' ? c.campaign_name : '',
            campaign_url: typeof c.campaign_url === 'string' ? c.campaign_url : '',
            segment: typeof c.segment === 'string' ? c.segment : null,
            leads_count:
              typeof c.leads_count === 'number' && Number.isFinite(c.leads_count) ? c.leads_count : 0,
            ...(requested !== undefined ? { leads_requested: requested } : {}),
            ...(attempted !== undefined ? { leads_attempted: attempted } : {}),
          };
        })
    : undefined;
  // Незнакомая стадия — «кампании нет»: считать её самым безопасным исходом
  // нельзя наоборот (повтор пропустил бы сегмент как уже созданный), а лишний
  // повтор создания сегменту без кампании ничего не портит.
  const pending = Array.isArray(r.pending)
    ? (r.pending as Array<Record<string, unknown>>)
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({
          segment: typeof p.segment === 'string' ? p.segment : null,
          stage: p.stage === 'leads' ? ('leads' as const) : ('campaign' as const),
        }))
    : undefined;
  const requestedTotal = optionalCount(r.leads_requested);
  const attemptedTotal = optionalCount(r.leads_attempted);
  return {
    campaign_id: r.campaign_id,
    campaign_name: typeof r.campaign_name === 'string' ? r.campaign_name : '',
    campaign_url: typeof r.campaign_url === 'string' ? r.campaign_url : '',
    leads_count: typeof r.leads_count === 'number' && Number.isFinite(r.leads_count) ? r.leads_count : 0,
    preset_id: typeof r.preset_id === 'string' ? r.preset_id : '',
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
    ...(campaigns && campaigns.length > 0 ? { campaigns } : {}),
    ...(requestedTotal !== undefined ? { leads_requested: requestedTotal } : {}),
    ...(attemptedTotal !== undefined ? { leads_attempted: attemptedTotal } : {}),
    ...(pending && pending.length > 0 ? { pending } : {}),
  };
}

/**
 * ЗАПУСК НЕ ЗАКОНЧЕН: в записи остались сегменты без кампании или без лидов.
 *
 * По этому признаку повтор запуска РАЗВЕТВЛЯЕТСЯ (launchTemplate.ts, шаги 1 и
 * 6): незакончённый запуск достраивается (созданные кампании переиспользуются),
 * закончённый ведёт себя как до 28.09.2026 — force создаёт новые кампании.
 * Записи до 28.09.2026 ключа `pending` не имеют вовсе, поэтому для них ответ
 * всегда false: историю RU-инструмента признак не переписывает.
 *
 * Тот же предикат — у ЭКРАНА, а не его копия: шаг «Review & Launch» кабинета
 * (components/client-eng/EngStepReview.tsx) решает им, предлагать ли «Launch all
 * (paused)» шаблону с записью, и подписывает бейдж. Поэтому `launch_info.pending`
 * проходит проекцию кабинета (clientEngProjection.ts, LAUNCH_PENDING_FIELDS):
 * без ключа экран видел бы законченным ЛЮБОЙ запуск и достройка осталась бы
 * недостижимой. Второго определения «запуск не закончен» быть не должно —
 * разойдясь, они дают либо спрятанную кнопку, либо второй запуск по уехавшей
 * аудитории.
 */
export function heLaunchIsIncomplete(info: HeTemplateLaunchInfo | null | undefined): boolean {
  return (info?.pending?.length ?? 0) > 0;
}

/** Ссылка на кампанию в Instantly (та же база URL, что и в остальном портале). */
export function instantlyCampaignUrl(campaignId: string): string {
  return `https://app.instantly.ai/app/campaign/${campaignId}`;
}

/** Как подписывать кампанию запуска (дефолты — внутренний контур, см. ниже). */
export interface HeCampaignNamingOptions {
  /** Префикс имени; '' — без префикса. */
  prefix?: string;
  /** Чем подписать базу, у которой нет filename. */
  fallbackBaseName?: string;
}

/**
 * Именование для проектов английского рынка (market='us'): имя кампании
 * доезжает до клиента (launch_info.campaign_name на дашборде и шаге баз),
 * поэтому ни внутреннего «HE · », ни русского фолбэка «база» в нём быть не
 * должно. Подставляет его launchTemplate.ts по рынку ПРОЕКТА, а не по контуру
 * запуска: у ru-проектов (в т.ч. всех запусков легаси-инструмента
 * /tools/hypothesis-engine) остаются дефолты ниже — staff узнаёт свои кампании
 * в списке рассыльщика именно по префиксу.
 */
export const HE_ENG_CAMPAIGN_NAMING: HeCampaignNamingOptions = {
  prefix: '',
  fallbackBaseName: 'audience',
};

/** Имя кампании: узнаваемое в списке Instantly, с датой запуска (+ сегмент при сплите). */
export function buildLaunchCampaignName(
  baseFilename: string | null | undefined,
  now = new Date(),
  segment?: string | null,
  naming?: HeCampaignNamingOptions,
): string {
  const prefix = naming?.prefix ?? 'HE · ';
  const fallback = naming?.fallbackBaseName ?? 'база';
  const base = (baseFilename ?? '').trim() || fallback;
  const seg = (segment ?? '').trim();
  return `${prefix}${base}${seg ? ` · ${seg}` : ''} · ${now.toISOString().slice(0, 10)}`.slice(0, 200);
}

export interface HeLaunchSequence {
  steps: ClientLaunchSequenceStep[];
  /** Сколько сегментных вариантов выкинуто (легаси-путь без сплита по сегментам). */
  droppedSegmentVariants: number;
  /** В скольких письмах были сегментные варианты. */
  lettersWithSegmentVariants: number;
  /** Сколько сегментных вариантов применено (сплит-путь с segmentWhen). */
  appliedSegmentVariants: number;
}

/**
 * Собирает ClientLaunchSequenceStep[] из финальных писем шаблона.
 *
 * Правила (зеркалят клиентский запуск):
 *   - тема только у первого письма; у follow-up'ов тема пустая — Instantly
 *     продолжает тред (Re: первой темы);
 *   - A/B-варианты письма → variants шага (основной текст = вариант A),
 *     всего не больше CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP с учётом основного;
 *   - wait_days остаются как есть: перевод в delay (wait_days СЛЕДУЮЩЕГО шага,
 *     у последнего 1) делает buildCampaignPayloadFromPreset — не дублируем;
 *   - segment_variants: без opts.segmentWhen НЕ переносятся (условные блоки
 *     Instantly не исполняет) — только считаем для предупреждения. С
 *     opts.segmentWhen (кампания конкретного сегмента при сплите) тело письма
 *     заменяется текстом варианта, чьё when совпало (регистронезависимо).
 *
 * Возвращает null, если писем нет.
 */
export function buildLaunchSequence(
  letters: HeChainLetter[] | null | undefined,
  opts?: { segmentWhen?: string | null },
): HeLaunchSequence | null {
  if (!Array.isArray(letters) || letters.length === 0) return null;

  const segmentKey = (opts?.segmentWhen ?? '').trim().toLowerCase();
  let droppedSegmentVariants = 0;
  let lettersWithSegmentVariants = 0;
  let appliedSegmentVariants = 0;

  const steps = letters.map<ClientLaunchSequenceStep>((letter, i) => {
    const variants = letter.segment_variants ?? [];
    let body = letter.body ?? '';
    if (variants.length > 0) {
      lettersWithSegmentVariants += 1;
      const matched = segmentKey
        ? variants.find((v) => (v.when ?? '').trim().toLowerCase() === segmentKey)
        : undefined;
      if (matched) {
        body = matched.text;
        appliedSegmentVariants += 1;
      } else {
        // Не материализовано (дефолтная кампания или легаси-путь) — считаем выкинутым.
        droppedSegmentVariants += variants.length;
      }
    }
    const first = i === 0;
    return {
      subject: first ? letter.subject ?? '' : '',
      body,
      wait_days:
        typeof letter.wait_days === 'number' && Number.isFinite(letter.wait_days)
          ? letter.wait_days
          : 0,
      variants: (letter.variants ?? [])
        .slice(0, CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP - 1)
        .map((v) => ({ subject: first ? v.subject ?? '' : '', body: v.body ?? '' })),
    };
  });

  return { steps, droppedSegmentVariants, lettersWithSegmentVariants, appliedSegmentVariants };
}

/** Текст предупреждения о выкинутых сегментных вариантах (null — если нечего). */
export function segmentVariantsWarning(sequence: HeLaunchSequence): string | null {
  if (sequence.droppedSegmentVariants === 0) return null;
  return (
    `Сегментные варианты (${sequence.droppedSegmentVariants} шт. в ` +
    `${sequence.lettersWithSegmentVariants} письмах) не попали в кампанию: ` +
    `Instantly не умеет условные блоки — в рассылку ушёл основной текст писем.`
  );
}

/**
 * Вердикты валидации почты, с которыми строка базы допускается в запуск.
 *
 * Словарь вердиктов задаёт шаг конструктора validate_emails: он пишет в сетку
 * колонку «Email Статус» (`processingSteps.ts`, ранг качества там же —
 * ok > catch_all > unknown > error > invalid > disposable), а импорт сборки
 * кладёт её значение на строку базы как `_email_status`
 * (`stages/baseCollect.ts`). Пустая ячейка означает «вердикта нет»: шаг не
 * дошёл до адреса или не запускался вовсе.
 *
 * Пропускаем ТОЛЬКО 'ok'. Почему не catch_all: такой домен подтверждает на
 * SMTP любой ящик, поэтому несуществующий адрес не отваливается на
 * рукопожатии, а превращается в поздний hard bounce или в попадание в
 * спам-ловушку — то есть бьёт уже по репутации домена отправителя. Обратной
 * связи по баунсам у движка нет ни в одном из контуров, чинить репутацию
 * будет нечем. Внутренний V2 катает catch_all осознанно (свои домены, ручной
 * присмотр специалиста) — для клиентских доменов это не аргумент.
 */
export const HE_LAUNCH_ACCEPTED_EMAIL_STATUSES: readonly string[] = ['ok'];

/**
 * Что вердикт строки говорит о её адресе: допускаем / отклоняем / вердикта
 * нет вовсе. 'missing' отделён от 'rejected' осознанно: это разные причины и
 * разные тексты для того, кто нажал запуск (см. launchTemplate.ts, шаг 5).
 *
 * Как поступать с 'missing', решает ВЫЗЫВАЮЩИЙ, и решение разное по рынку:
 * у us-проекта строка без вердикта не отправляется (письма уедут с домённых
 * ящиков ENG-клиента), а в RU-инструменте она отправляется как и до
 * 26.09.2026 — частично собранная база там штатный рабочий случай, — но
 * попадает в предупреждение запуска. Эта функция сама ничего не запрещает.
 */
export type HeLaunchEmailVerdict = 'accepted' | 'rejected' | 'missing';

/** Вердикт по значению `_email_status` строки базы (регистр и пробелы неважны). */
export function heLaunchEmailVerdict(rawStatus: unknown): HeLaunchEmailVerdict {
  if (typeof rawStatus !== 'string') return 'missing';
  const status = rawStatus.trim().toLowerCase();
  if (!status) return 'missing';
  return HE_LAUNCH_ACCEPTED_EMAIL_STATUSES.includes(status) ? 'accepted' : 'rejected';
}

/**
 * Кап «адресов на компанию», записанный стадией сборки в
 * `he_bases.collect_info.construct.contact_cap` при ПОСТАНОВКЕ джобы
 * конструктора (`stages/baseCollect.ts`, dispatchConstructJob). null — ключа
 * нет.
 *
 * Зачем это запуску: ключ появился 26.09.2026 вместе с обязательным для
 * market='us' шагом split_emails, и другого кода, который бы его писал, нет.
 * Поэтому у us-базы его ОТСУТСТВИЕ — маркер «сетку собирал прежний контракт,
 * без разноса адресов по строкам», а значит вердикт в «Email Статус»
 * принадлежит ЛУЧШЕМУ адресу склеенной ячейки, тогда как импорт положил на
 * строку ПЕРВЫЙ (`importConstructRows`: `extractEmail`). Строка может читаться
 * как «a@acme.com / ok», хотя валидацию прошёл b@acme.com. Как это используется
 * — launchTemplate.ts, шаг 4c.
 *
 * Границы маркера, честно:
 *   - он доказывает только «джобу ставил новый код». Что split_emails ДОШЁЛ до
 *     конца, доказывает не он, а порядок шагов: split стоит перед
 *     validate_emails, поэтому оборвавшаяся раньше джоба вообще не оставляет
 *     вердиктов — такую базу отсекает гейт вердиктов, а не этот маркер. Если
 *     порядок в CONSTRUCT_STEPS_AFTER_SPLIT_US когда-нибудь переставят,
 *     проверять придётся selected_steps самой джобы;
 *   - для market='ru' он не значит НИЧЕГО: в RU-списке шагов split_emails нет
 *     ни до, ни после 26.09.2026, поэтому RU-вердикт — по-прежнему лучший из
 *     ячейки. Это состояние HEAD, отдельное продуктовое решение, и по
 *     маркеру его не отличить;
 *   - колонка `he_bases.contact_cap_applied` для той же цели НЕ годится: её не
 *     пишут на инсталляции без миграции 20260926_0001 и у частичного импорта.
 */
export function heConstructContactCap(collectInfo: unknown): number | null {
  if (!collectInfo || typeof collectInfo !== 'object') return null;
  const construct = (collectInfo as { construct?: unknown }).construct;
  if (!construct || typeof construct !== 'object') return null;
  const cap = (construct as { contact_cap?: unknown }).contact_cap;
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_COLUMN_NAME_RE = /e-?mail|почта|емейл/i;

/**
 * Колонка с email: сначала по имени («Email», «e-mail», «Почта»…), иначе по
 * содержимому — первая колонка, где ≥60% первых непустых значений похожи на email.
 */
export function findEmailColumn(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string | null {
  const byName = columns.find((c) => EMAIL_COLUMN_NAME_RE.test(c));
  if (byName) return byName;

  for (const col of columns) {
    const values = rows
      .slice(0, 50)
      .map((r) => String(r[col] ?? '').trim())
      .filter((v) => v.length > 0)
      .slice(0, 20);
    if (values.length === 0) continue;
    const hits = values.filter((v) => EMAIL_RE.test(v.toLowerCase())).length;
    if (hits / values.length >= 0.6) return col;
  }
  return null;
}

/* ── Стандартные поля лида рассыльщика ── */

/** Канонические имена колонки телефона, в порядке предпочтения. */
const PHONE_CANONICAL_COLUMNS: readonly string[] = ['phone', 'телефон'];
const PHONE_COLUMN_NAME_RE = /phone|телефон/i;

/** Колонки базы, из которых берутся СТАНДАРТНЫЕ поля лида. */
interface HeLeadStandardColumns {
  company: string | null;
  website: string | null;
  phone: string | null;
}

/**
 * Откуда брать значения стандартных полей лида (company_name/website/phone).
 *
 * Компанию и сайт ищет тот же двухъярусный резолвер, что и ключ компании у
 * потолка запуска (findCompanyKeyColumns): контракт авто-сборки
 * (HE_AUTO_COLLECT_COLUMNS) сначала, догадка по имени — потом, для ручного CSV
 * специалиста. Двух ответов на вопрос «где в этой базе компания» быть не должно.
 */
function findLeadStandardColumns(columns: string[]): HeLeadStandardColumns {
  const key = findCompanyKeyColumns(columns);
  return {
    company: key.company,
    website: key.website,
    phone: pickCompanyKeyColumn(columns, PHONE_CANONICAL_COLUMNS, PHONE_COLUMN_NAME_RE).column,
  };
}

/**
 * Имя переменной в том виде, в котором её видит рассыльщик: регистр и
 * разделители он не различает, поэтому {{companyName}} и {{company_name}} —
 * одна и та же переменная, и его СТАНДАРТНОЕ поле company_name спорит с
 * одноимённой custom-переменной письма.
 */
function providerVariableKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * ВСЕ написания, которыми письма зовут ОДНО И ТО ЖЕ стандартное поле лида.
 *
 * Зачем список, а не имя самого поля: правило коллизии ниже сравнивало только
 * ключ поля рассыльщика ('companyname'), а компанию письма движка зовут ДВУМЯ
 * именами — {{company}} и {{companyName}}. Это не догадка: обе формы стоят в
 * словаре синонимов стадии шаблона (`stages/template.ts`, OPERATOR_ALIASES:
 * companyname/company, website/site, phone), обе отдельно ищет подпись превью
 * (`renderPreview.ts`, previewRowLabel: 'companyname' | 'company'), и в
 * personalization_plan.operator_mapping штатно лежит то написание, которое
 * оказалось в тексте. После providerVariableKey ключи 'company' и 'companyname'
 * РАЗНЫЕ, поэтому {{company}} с другим значением коллизией не считался: поле
 * company_name уезжало рядом с ним, а чья переменная победит в письме, решает
 * рассыльщик — ровно тот риск, ради которого правило и написано.
 *
 * Регистр и разделители внутри формы не важны (их складывает
 * providerVariableKey: company_name = companyName = 'companyname'), поэтому в
 * списке только РАЗНЫЕ ключи. Догадок не добавлять: каждая лишняя форма — это
 * стандартное поле, которое перестаёт доезжать до рассыльщика.
 */
const STANDARD_FIELD_VARIABLE_FORMS = {
  /** company_name = companyName; отдельная форма — короткое {{company}}. */
  company: ['company_name', 'company'],
  website: ['website', 'site'],
  phone: ['phone'],
} as const;

export interface MapBaseRowsInput {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  operatorMapping?: HeOperatorMapping[];
  /**
   * Заполнять ли СТАНДАРТНЫЕ поля лида рассыльщика (company_name, website,
   * phone) из колонок базы — ПОМИМО custom-переменных, а не вместо них: письма
   * ссылаются на переменные по имени оператора, и убрать их значило бы сломать
   * подстановку.
   *
   * Зачем: до 28.09.2026 запуск складывал все колонки только в
   * custom_variables, поэтому собственные поля лида у рассыльщика оставались
   * пустыми — его родные функции (карточка лида, список кампании, его
   * собственные переменные) компании и сайта не видели.
   *
   * Значение поля ставится ТОЛЬКО когда оно не может переписать письмо: если у
   * строки есть custom-переменная ЛЮБОГО из написаний этого поля (в понимании
   * рассыльщика — providerVariableKey; список форм —
   * STANDARD_FIELD_VARIABLE_FORMS, в нём и короткое {{company}}) с ДРУГИМ
   * значением, поле остаётся пустым, а отказ
   * считается (standardFieldsHeldBack). Причина: чья переменная победит при
   * коллизии, решает рассыльщик, а превью письма (renderPreview) обещает
   * значение ИМЕННО custom-переменной — реальность обязана ему соответствовать.
   * Совпадающее значение коллизией не является: что бы он ни выбрал, в письме
   * один и тот же текст.
   *
   * Без ключа — прежнее поведение (только custom-переменные): так зовёт ночной
   * долив, у которого свой durable-журнал отчётности читает company_name лида.
   */
  standardFields?: boolean;
  /**
   * Колонка адреса, уже найденная вызывающим. Передаётся, чтобы ОДНА детекция
   * обслуживала и гейт вердиктов, и маппинг: гейту колонка нужна ДО фильтра
   * строк, маппингу — после, а детекция по содержимому (findEmailColumn: доля
   * похожих значений среди первых непустых) зависит от НАБОРА строк. Посчитанная
   * дважды, она могла назвать разные колонки — вплоть до «колонки нет» на
   * остатке, у которого гейт снял как раз строки с адресами. Тогда база
   * отвечала бы «не найдена колонка с email» вместо честной причины отсева.
   *
   * null — «искали и не нашли», это тоже ответ (детекцию не повторяем).
   * Ключа нет вовсе — ищем сами по переданным rows (прежнее поведение; так
   * зовёт ночной долив).
   */
  emailColumn?: string | null;
}

export interface MapBaseRowsResult {
  leads: LeadCreatePayload[];
  /** Колонка, из которой взят email (null — не нашли → лидов нет). */
  emailColumn: string | null;
  /** Индекс исходной строки базы для каждого лида (параллельно leads) — нужен
   *  сплиту по сегментам при запуске. */
  leadRowIndices: number[];
  /**
   * Строки, чья ячейка email держит ДВА и больше адреса («a@x.com, b@y.com»).
   * Контракт he_bases — один адрес на строку, и EMAIL_RE привязан к началу и
   * концу значения, поэтому такая ячейка не даёт лида: компания выпадает из
   * запуска целиком.
   *
   * Почему не берём первый адрес: вердикт валидации на строке ОДИН на всю
   * ячейку, и validate_emails пишет в него ЛУЧШИЙ из адресов ячейки. То есть
   * 'ok' у «a@x.com, b@y.com» может относиться к b, а a быть невалидным —
   * взять первый значило бы отправить письмо на адрес без вердикта под
   * вердиктом соседа. Поэтому строку не отправляем, но и не теряем молча:
   * счётчик уходит наверх, и запуск о нём предупреждает.
   *
   * Живые источники таких ячеек: базы, собранные до разделения адресов по
   * строкам, и ручные CSV специалиста.
   */
  multiAddressRows: number;
  /**
   * Строки, где ячейка email непустая, но адреса в ней нет (или он утонул в
   * мусоре: «нет почты», «mail: a@x.com»). Тоже не молча: счётчик наверх.
   * Пустая ячейка сюда НЕ попадает — у автосборки это штатная строка компании,
   * которой почту не нашли.
   */
  malformedEmailRows: number;
  /**
   * Сколько стандартных полей (по всем лидам) оставлено пустыми из-за
   * одноимённой переменной письма с другим значением — см. standardFields.
   * 0 при standardFields: коллизий в этой базе нет. Без standardFields всегда 0.
   */
  standardFieldsHeldBack: number;
}

/**
 * Строки he_bases.data → лиды Instantly, по мотивам mapCsvRowsToLeads:
 *   - email обязателен, lowercase, дедуп; ячейка обязана содержать РОВНО один
 *     адрес (контракт he_bases). Ячейка с двумя адресами или с мусором лида не
 *     даёт — но и не исчезает молча: см. multiAddressRows/malformedEmailRows;
 *   - operator_mapping применяется для именования переменных: matched оператор
 *     «var → колонка» кладёт значение ячейки в custom_variables под именем
 *     оператора (так {{var}} в письме подставится на стороне Instantly).
 *     Переменная эмитится ВСЕГДА: пустая ячейка → fallback маппинга, иначе ''
 *     (Instantly рендерит существующую пустую переменную как ''; незаданная
 *     переменная осталась бы в письме литералом {{var}}, а превью
 *     (renderPreview) обещает именно подстановку — реальность обязана ей
 *     соответствовать). Unmatched-оператор с fallback → fallback у всех лидов;
 *   - остальные колонки проходят в custom_variables под своими именами.
 */
export function mapBaseRowsToLeads(input: MapBaseRowsInput): MapBaseRowsResult {
  const { rows, columns, operatorMapping } = input;

  const emailColumn =
    input.emailColumn !== undefined ? input.emailColumn : findEmailColumn(columns, rows);
  if (!emailColumn) {
    return {
      leads: [],
      emailColumn: null,
      leadRowIndices: [],
      multiAddressRows: 0,
      malformedEmailRows: 0,
      standardFieldsHeldBack: 0,
    };
  }
  const standardColumns = input.standardFields ? findLeadStandardColumns(columns) : null;

  // Колонки, которые занял хотя бы один оператор: их значение эмитится под
  // именем КАЖДОГО такого оператора, а не под именем колонки.
  const claimedColumns = new Set<string>();
  // operator → fallback для unmatched (fallback'ы unmatched идут всем лидам).
  const unmatchedFallbacks = new Map<string, string>();
  // Все matched-операторы: переменную надо эмитить даже при пустой ячейке.
  const matchedOperators = new Map<string, { column: string; fallback: string }>();
  for (const m of operatorMapping ?? []) {
    if (!m?.operator) continue;
    if (m.matched && m.column) {
      claimedColumns.add(m.column);
      if (!matchedOperators.has(m.operator)) {
        matchedOperators.set(m.operator, { column: m.column, fallback: (m.fallback ?? '').trim() });
      }
    } else if (!m.matched) {
      const f = (m.fallback ?? '').trim();
      if (f && !unmatchedFallbacks.has(m.operator)) unmatchedFallbacks.set(m.operator, f);
    }
  }

  const leads: LeadCreatePayload[] = [];
  const leadRowIndices: number[] = [];
  const seenEmails = new Set<string>();
  let multiAddressRows = 0;
  let malformedEmailRows = 0;
  let standardFieldsHeldBack = 0;

  rows.forEach((row, rowIndex) => {
    const cell = String(row[emailColumn] ?? '').trim();
    if (!cell) return;
    const email = cell.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      // Ячейка есть, но это не один адрес. Считаем причину и идём дальше:
      // решение «не отправлять» прежнее, новое — что об этом сообщают.
      if (extractEmails(cell).length > 1) multiAddressRows += 1;
      else malformedEmailRows += 1;
      return;
    }
    if (seenEmails.has(email)) return;
    seenEmails.add(email);

    const lead: LeadCreatePayload = { email };
    const customVars: Record<string, string> = {};

    for (const col of columns) {
      if (col === emailColumn) continue;
      if (claimedColumns.has(col)) continue;
      const val = String(row[col] ?? '').trim();
      if (!val) continue;
      customVars[col] = val;
    }
    // Значение берётся ПО ОПЕРАТОРУ, из его собственной колонки: два оператора
    // на одну колонку ({{company}} и {{companyName}}) должны оба подставиться,
    // а не только первый. Пустая ячейка → fallback, иначе пустая строка.
    for (const [op, spec] of matchedOperators) {
      const val = String(row[spec.column] ?? '').trim();
      customVars[op] = val || spec.fallback || '';
    }
    for (const [op, fallback] of unmatchedFallbacks) {
      if (customVars[op] === undefined) customVars[op] = fallback;
    }

    if (Object.keys(customVars).length > 0) {
      lead.custom_variables = customVars;
    }

    // Стандартные поля лида — ПОСЛЕ custom-переменных: правило коллизии
    // сравнивает значение колонки с переменной ЭТОЙ строки (см. standardFields).
    if (standardColumns) {
      const varsByProviderKey = new Map<string, string>();
      for (const [name, value] of Object.entries(customVars)) {
        const key = providerVariableKey(name);
        if (!varsByProviderKey.has(key)) varsByProviderKey.set(key, value);
      }
      // Коллизией считается ЛЮБОЕ из написаний поля (STANDARD_FIELD_VARIABLE_FORMS):
      // письмо зовёт компанию и {{companyName}}, и {{company}}. Счётчик считает
      // ПОЛЕ, а не формы: «сколько полей осталось пустыми» — его прежний смысл.
      const takeStandard = (column: string | null, forms: readonly string[]): string | null => {
        if (!column) return null;
        const value = String(row[column] ?? '').trim();
        if (!value) return null;
        for (const form of forms) {
          const collided = varsByProviderKey.get(providerVariableKey(form));
          if (collided !== undefined && collided !== value) {
            standardFieldsHeldBack += 1;
            return null;
          }
        }
        return value;
      };
      const companyName = takeStandard(standardColumns.company, STANDARD_FIELD_VARIABLE_FORMS.company);
      if (companyName) lead.company_name = companyName;
      const website = takeStandard(standardColumns.website, STANDARD_FIELD_VARIABLE_FORMS.website);
      if (website) lead.website = website;
      const phone = takeStandard(standardColumns.phone, STANDARD_FIELD_VARIABLE_FORMS.phone);
      if (phone) lead.phone = phone;
    }

    leads.push(lead);
    leadRowIndices.push(rowIndex);
  });

  return {
    leads,
    emailColumn,
    leadRowIndices,
    multiAddressRows,
    malformedEmailRows,
    standardFieldsHeldBack,
  };
}

/* ── Потолок запуска: адреса против компаний ── */

/**
 * Колонки, по которым строки одной компании узнают друг друга.
 *
 * Пара «компания + сайт», а не одна компания: «однофамильцев» (одно имя у
 * разных фирм) различают сайты — тот же ключ, что у шага конструктора
 * cap_emails_per_company (`lib/tools/processingSteps.ts`, makeCompanyKeyFn) и у
 * капа после импорта (`stages/baseCollect.ts`, capImportedRows).
 *
 * ПОРЯДОК ВЫБОРА (два яруса, не «первая подходящая по имени»). Ключ компании —
 * то, на чём стоит вся арифметика потолка: перепутанная колонка не ломает
 * запуск, а ТИХО превращает «по одному адресу каждой компании» в «первые N
 * адресов подряд». Поэтому:
 *   1. КАНОН — точное совпадение (trim + lowercase) с именем, которое эта
 *      сборка реально производит. Контракт he_bases.columns авто-базы —
 *      HE_AUTO_COLLECT_COLUMNS (`stages/baseCollect.ts`), то есть ровно
 *      'company' и 'website'; заголовки сетки конструктора
 *      (CONSTRUCT_HEADERS_RU/EN и EN-алиас 'Website') перечислены для CSV,
 *      выгруженного из конструктора и загруженного специалистом обратно.
 *      Ярус перебирает СПИСОК, а не сетку, поэтому порядок колонок базы на
 *      ответ не влияет и две подходящие колонки не спорят между собой.
 *   2. ИМЯ — прежний поиск по регулярке, для сеток, которых этот пайплайн не
 *      производит (ручной CSV: колонки называются как угодно). Ярус
 *      сохраняет прежнее поведение (первая подходящая в порядке сетки), но
 *      честно сообщает наверх, что выбор сделан догадкой и сколько колонок
 *      подошло: догадываться лучше, чем не найти ничего, а НЕ ЗНАТЬ, что
 *      догадались, нельзя.
 * Ни одна колонка не подошла — source 'none' и column null: строки теряют
 * ключ, и каждый адрес становится «своей компанией» (см. вызывающего). Это
 * тоже уходит в журнал, а не остаётся молчаливой деградацией.
 */
const COMPANY_COLUMN_NAME_RE = /company|компания|название|наименование|организация/i;
const WEBSITE_COLUMN_NAME_RE = /website|site|сайт|домен|domain/i;
/** Канонические имена колонки компании, в порядке предпочтения. */
const COMPANY_CANONICAL_COLUMNS: readonly string[] = ['company', 'компания'];
/** Канонические имена колонки сайта, в порядке предпочтения. */
const WEBSITE_CANONICAL_COLUMNS: readonly string[] = ['website', 'сайт', 'site'];

/** Чем выбрана колонка ключа: контрактом сборки, догадкой по имени или ничем. */
export type HeLaunchCompanyColumnSource = 'canonical' | 'named' | 'none';

/** Как именно нашлись колонки ключа — уходит в журнал запуска, а не теряется. */
export interface HeLaunchCompanyColumnResolution {
  company: HeLaunchCompanyColumnSource;
  website: HeLaunchCompanyColumnSource;
  /** Колонок, подошедших ПО ИМЕНИ (ярус 2); >1 — сетка неоднозначна. */
  companyNameMatches: number;
  websiteNameMatches: number;
}

export interface HeLaunchCompanyColumns {
  company: string | null;
  website: string | null;
  /** Чем выбрана каждая из них (для журнала; на сам ключ не влияет). */
  resolution: HeLaunchCompanyColumnResolution;
}

function pickCompanyKeyColumn(
  columns: string[],
  canonical: readonly string[],
  nameRe: RegExp,
): { column: string | null; source: HeLaunchCompanyColumnSource; nameMatches: number } {
  for (const want of canonical) {
    const hit = columns.find((c) => c.trim().toLowerCase() === want);
    if (hit) return { column: hit, source: 'canonical', nameMatches: 0 };
  }
  const named = columns.filter((c) => nameRe.test(c));
  if (named.length > 0) return { column: named[0], source: 'named', nameMatches: named.length };
  return { column: null, source: 'none', nameMatches: 0 };
}

/**
 * Найти колонки компании и сайта (обеих может не быть). Одна и та же колонка на
 * оба поля («Company website» подходит и туда, и туда) НЕ разводится: ключ от
 * этого не меняется — значение просто повторяется в обоих его полях, а
 * группировка строк остаётся той же.
 */
export function findCompanyKeyColumns(columns: string[]): HeLaunchCompanyColumns {
  const company = pickCompanyKeyColumn(columns, COMPANY_CANONICAL_COLUMNS, COMPANY_COLUMN_NAME_RE);
  const website = pickCompanyKeyColumn(columns, WEBSITE_CANONICAL_COLUMNS, WEBSITE_COLUMN_NAME_RE);
  return {
    company: company.column,
    website: website.column,
    resolution: {
      company: company.source,
      website: website.source,
      companyNameMatches: company.nameMatches,
      websiteNameMatches: website.nameMatches,
    },
  };
}

/**
 * Ключ «одна компания» для строки базы. Пустая строка — компанию по строке не
 * опознать (обеих колонок нет или обе пусты); вызывающий обязан в этом случае
 * считать строку отдельной компанией, а не склеивать все такие строки в одну.
 *
 * Нормализация НАМЕРЕННО лёгкая (trim + lowercase), без юрформ и хостов
 * (normalizeCompanyForDedup/normalizeWebsiteForDedup стадии сборки): строки, на
 * которые split_emails разнёс адреса ОДНОЙ компании, унаследовали её ячейки
 * компании и сайта дословно, поэтому байтового равенства достаточно. Тяжёлая
 * нормализация нужна дедупу РАЗНЫХ источников, а здесь она добавила бы риск
 * склеить две настоящие компании — в этой задаче ошибка в сторону «склеили»
 * хуже: она отняла бы у компании место в запуске.
 */
export function heLaunchCompanyKey(
  row: Record<string, unknown>,
  cols: HeLaunchCompanyColumns,
): string {
  const company = cols.company ? String(row[cols.company] ?? '').trim().toLowerCase() : '';
  const website = cols.website ? String(row[cols.website] ?? '').trim().toLowerCase() : '';
  if (!company && !website) return '';
  // JSON.stringify даёт ключ без коллизий склейки (["ab","c"] ≠ ["a","bc"]).
  return JSON.stringify([company, website]);
}

/**
 * Сила вердикта строки при выборе, какой адрес компании сильнее. Порядок тот
 * же, что у heLaunchEmailVerdict: допущенный адрес сильнее непроверенного,
 * непроверенный — сильнее отклонённого.
 *
 * Отклонённые и (у market='us') непроверенные строки до потолка не доходят —
 * их снял гейт запуска. Ранг всё равно задан для всех трёх: в RU-контуре
 * непроверенные строки законно уезжают, и там «сначала проверенный адрес
 * компании» — единственный осмысленный порядок.
 */
const HE_LAUNCH_VERDICT_STRENGTH: Record<HeLaunchEmailVerdict, number> = {
  accepted: 2,
  missing: 1,
  rejected: 0,
};

export interface HeLaunchCapInput {
  /** Строки базы, из которых собраны лиды (уже после гейта вердиктов). */
  rows: Array<Record<string, unknown>>;
  columns: string[];
  /** Индекс строки для каждого лида — mapBaseRowsToLeads.leadRowIndices. */
  leadRowIndices: readonly number[];
  /** Потолок АДРЕСОВ; по умолчанию HE_LAUNCH_MAX_LEADS. */
  limit?: number;
}

export interface HeLaunchCapSelection {
  /** Позиции лидов, которые уезжают, в ИСХОДНОМ порядке базы. */
  keptLeadPositions: number[];
  /** Компаний, у которых уехал хотя бы один адрес. */
  companiesSent: number;
  /** Адресов уезжает (= keptLeadPositions.length). */
  addressesSent: number;
  /** Адресов снял потолок. */
  addressesHeldBack: number;
  /** Компаний, которым не досталось ни одного адреса. */
  companiesHeldBack: number;
  /**
   * Чем выбраны колонки ключа компании. Не влияет ни на одно число выше — это
   * ДИАГНОСТИКА для журнала запуска: 'named' означает «колонку угадали по
   * имени», 'none' по обоим полям — «ключа нет вовсе», и тогда правило «по
   * одному адресу на компанию» вырождается в «первые N адресов подряд».
   */
  companyKeyResolution: HeLaunchCompanyColumnResolution;
  /**
   * Адресов, у которых компанию по строке опознать не удалось (обе ячейки
   * ключа пусты или колонок нет): каждый такой адрес считается ОТДЕЛЬНОЙ
   * компанией, поэтому число companiesSent на столько же завышено против
   * настоящих компаний. Столбик для журнала: 0 — потолок отработал ровно так,
   * как обещает предупреждение клиенту.
   */
  addressesWithoutCompanyKey: number;
}

/**
 * Какие адреса взять в запуск, когда их больше потолка.
 *
 * ПРАВИЛО: потолок сначала берёт по ОДНОМУ — сильнейшему — адресу каждой
 * компании, и только потом вторые адреса тех, кто уже попал, потом третьи и так
 * далее (раунды по «глубине»). Причина продуктовая: клиент заказывал КОМПАНИИ, а
 * потолок считает АДРЕСА, и после разноса адресов по строкам одна компания
 * занимает до capа строк. Запуск на 2000 компаний по одному адресу — это 2000
 * шансов на ответ; запуск на 400 компаний по пять адресов — 400 шансов и пять
 * писем в одну приёмную. Внутри компании порядок — сила вердикта
 * (HE_LAUNCH_VERDICT_STRENGTH), при равенстве — порядок строк базы, то есть
 * приоритет задач плана сборки; порядок компаний — первое появление в базе (то
 * же свойство, на которое опирается capImportedRows).
 *
 * Потолок НЕ поднимается и не отказывает: он выбирает. Ни одна снятая строка
 * при этом не помечается отправленной — функция чистая и ничего не пишет.
 */
export function selectLeadsWithinLaunchCap(input: HeLaunchCapInput): HeLaunchCapSelection {
  const { rows, leadRowIndices } = input;
  const limit = Math.max(1, input.limit ?? HE_LAUNCH_MAX_LEADS);
  const cols = findCompanyKeyColumns(input.columns);

  const groups = new Map<string, number[]>();
  let addressesWithoutCompanyKey = 0;
  leadRowIndices.forEach((rowIndex, leadPos) => {
    // Компанию по строке не опознать — считаем её отдельной компанией
    // (деградация к поштучному поведению, как в makeCompanyKeyFn), иначе все
    // безымянные строки схлопнулись бы в одну «компанию» и потолок оставил бы
    // от них один адрес. Считаем такие строки: молчаливой эта деградация быть
    // не должна — на ней правило «по одному адресу на компанию» перестаёт
    // что-либо значить.
    const rowKey = heLaunchCompanyKey(rows[rowIndex] ?? {}, cols);
    if (!rowKey) addressesWithoutCompanyKey += 1;
    const key = rowKey || `row:${leadPos}`;
    const list = groups.get(key);
    if (list) list.push(leadPos);
    else groups.set(key, [leadPos]);
  });

  const strengthOf = (leadPos: number): number =>
    HE_LAUNCH_VERDICT_STRENGTH[heLaunchEmailVerdict(rows[leadRowIndices[leadPos]]?._email_status)];
  const ranked = [...groups.values()].map((positions) =>
    [...positions].sort((a, b) => strengthOf(b) - strengthOf(a) || a - b),
  );

  const kept = new Set<number>();
  const deepest = ranked.reduce((max, group) => Math.max(max, group.length), 0);
  for (let depth = 0; depth < deepest && kept.size < limit; depth += 1) {
    for (const group of ranked) {
      if (kept.size >= limit) break;
      const leadPos = group[depth];
      if (leadPos !== undefined) kept.add(leadPos);
    }
  }

  let companiesSent = 0;
  for (const group of ranked) {
    if (group.some((leadPos) => kept.has(leadPos))) companiesSent += 1;
  }

  return {
    keptLeadPositions: [...kept].sort((a, b) => a - b),
    companiesSent,
    addressesSent: kept.size,
    addressesHeldBack: leadRowIndices.length - kept.size,
    companiesHeldBack: ranked.length - companiesSent,
    companyKeyResolution: cols.resolution,
    addressesWithoutCompanyKey,
  };
}
