import { supabaseInstantly as supabaseAdmin } from '@/lib/supabaseInstantly';
import * as instantly from './client';
import { getBodyText, type ThreadContext } from './leadQualifier';
import {
  mappingCampaignId,
  parseAccountCampaignMappingItems,
  type AccountCampaignMappingItem,
} from './accountCampaignMappings';
import {
  qualifyOneReply,
  getCampaignsByAccountCached,
  isTransientQualifyError,
  persistTransientQualificationRetry,
  strayColumnsSupported,
} from './leadQualificationWorker';
import type { Email } from './types';

/**
 * Others-watchdog: достаёт РЕАЛЬНЫЕ ответы лидов из вкладки Unibox «Others».
 *
 * Зачем: Instantly раскладывает часть настоящих ответов на наш аутрич в
 * «Others» (вместе с ~97% прогрева/спама), и основной поллер их не видит —
 * он читает дефолтную вкладку (Primary). Замер 16.07.2026 на 3 днях трафика:
 * из 13 400 Others-писем 10 относились к кампаниям, реально запущенным в
 * Instantly, и среди них был горячий лид («опросник во вложении, давайте
 * созвонимся»), пролежавший необработанным. Прочие ответы в Others адресованы
 * доменам, чьи кампании крутятся во внешних платформах (Coldy/Trigga) — их
 * там уже разбирают, и сюда их тащить НЕЛЬЗЯ (задублируем спецам).
 *
 * Как: редкий тик (дефолт 15 мин) → дешёвые локальные фильтры → атрибуция к
 * кампании через account-campaign-mappings → существующий qualifyOneReply
 * (guard'ы, критерии, дедуп, алерты). ИИ видит только выживших после фильтров
 * (единицы в день), не весь поток.
 *
 * Нагрузка на Instantly API (воркспейс-лимит ~10 RPM, основной поллер сам ест
 * до ~10 вызовов/мин — поэтому всё зажато дважды): 2 страницы Others на тик
 * (~0.07 RPM, пейс 2с) + ~11 страниц /accounts раз в 12ч (пейс 2с) + пробы
 * атрибуции/тем — ВСЕ через единый бюджет с пейсингом 800мс
 * (INSTANTLY_OTHERS_PROBE_BUDGET, дефолт 25 вызовов/тик ≈ ≤1.7 RPM среднего
 * даже в warmup-волну; исчерпание = отложить на следующий тик, не дроп).
 * Типичный тик: 4-8 проб.
 *
 * Фильтр (валидирован замером, см. wiki-память instantly-others-tab-unreachable):
 *  1. отправитель НЕ с нашего рассыльного домена (иначе это внутренний прогрев);
 *  2. тема/тело ЦИТИРУЮТ наш рассыльный домен — признак ответа на наш аутрич.
 *     Матч по контенту, а не по списку контактов: лиды часто отвечают с личной
 *     почты (40 из 123 в замере), а контакты ежедневно удаляются из Instantly —
 *     список контактов их не поймал бы;
 *  3. не DMARC-репорт (сабж «Report Domain: <наш домен>» — они тоже цитируют
 *     наш домен!) и не машинный role-адрес;
 *  4. цитируемый домен имеет квалифицируемую кампанию (project-linked или
 *     client self-serve). Прогрев-домены Coldy/Trigga отсеиваются именно здесь:
 *     у них в Instantly кампаний нет.
 *
 * Поток Others — непривязанный (в отличие от Primary-поллера, где письма уже
 * приклеены Instantly к кампании), поэтому квалификация идёт со строже
 * зажатыми side-effect'ами: DM клиенту — только при вердикте «лид»
 * (clientDmOnlyOnLead), спам, цитирующий домен клиента, не должен долетать
 * до его Telegram как «ответ в кампании».
 */

const OTHERS_PAGE_SIZE = 100;
const MAX_MAILBOX_PROBES_PER_DOMAIN = 4;
const MAX_CAMPAIGN_PROBES_PER_EMAIL = 5;

function workerLog(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[instantly-others][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

function envNumber(name: string, fallback: number): number {
  const env = process.env[name];
  // Пустая строка = «не задано»: Number('')=0 молча обнулял бы TTL/задержки
  // (TTL=0 = кэш фактически выключен, перефетч каждый тик).
  const raw = env === undefined || env === '' ? fallback : Number(env);
  return Number.isFinite(raw) ? raw : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Бюджет + пейсер Instantly-проб на тик (маппинги атрибуции + sent-пробы тем).
 * Воркспейс-лимит ~10 RPM почти целиком ест основной поллер, а warmup-волна без
 * бюджета давала бёрст в сотни вызовов за тик (до 4 маппингов на новый домен +
 * до 3 sent-проб на письмо × сотня кандидатов) → 429 обоим контурам (гипотеза
 * инцидента 20.07). take() = false при исчерпании — вызывающий код ОТКЛАДЫВАЕТ
 * работу на следующий тик (null), не дропает и не пишет негативный кэш.
 */
function makeProbeMeter(budget: number, delayMs: number) {
  let used = 0;
  return {
    /** Первая проба тика без паузы, дальше — delayMs между любыми двумя пробами. */
    async take(): Promise<boolean> {
      if (used >= budget) return false;
      if (used > 0) await sleep(delayMs);
      used++;
      return true;
    },
    exhausted(): boolean {
      return used >= budget;
    },
  };
}

type ProbeMeter = ReturnType<typeof makeProbeMeter>;

const API_KEY = () =>
  process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  '';

// Только ЯВНО машинные local-part'ы. Человеческие групповые ящики
// (sales@/info@/office@/help@) НЕ фильтруем: в замере горячий лид пришёл с
// sales@hotelbenedict.ru — такие письма должен судить ИИ, а не регэксп.
const ROLE_LOCAL_RE =
  /^(?:no[-_.]?reply|postmaster|mailer-daemon|mailsystem|adminreport|dmarc[a-z0-9._-]*|bounce[a-z0-9._-]*|abuse|daemon|robot\d*)$/;

// DMARC-агрегаты цитируют наш домен в теме («Report Domain: <домен>») — без
// этого правила они прошли бы контент-матч (60 из 123 матчей в замере).
const DMARC_SUBJECT_RE = /report domain:/i;

export type OthersScreenVerdict =
  | 'candidate'
  | 'invalid'
  | 'internal'
  | 'role'
  | 'dmarc'
  | 'no-citation';

export interface OthersScreenResult {
  verdict: OthersScreenVerdict;
  citedDomain?: string;
}

/**
 * Чистый фильтр одного Others-письма против множества наших рассыльных
 * доменов. Порядок проверок важен: дешёвые и однозначные — раньше.
 */
export function screenOthersEmail(
  email: Email,
  ourDomains: ReadonlySet<string>,
): OthersScreenResult {
  const sender = (email.from_address_email ?? '').trim().toLowerCase();
  if (!email.id || !sender.includes('@')) return { verdict: 'invalid' };
  if ((email.ue_type ?? 2) !== 2) return { verdict: 'invalid' };

  const localPart = sender.split('@')[0] ?? '';
  const senderDomain = sender.split('@')[1] ?? '';
  if (ourDomains.has(senderDomain)) return { verdict: 'internal' };
  if (ROLE_LOCAL_RE.test(localPart)) return { verdict: 'role' };

  const subject = email.subject ?? '';
  if (DMARC_SUBJECT_RE.test(subject)) return { verdict: 'dmarc' };

  // Скринируем и извлечённый текст, и СЫРОЙ html: цитата нашего домена может
  // жить только в href/mailto-атрибуте (адрес отрисован именем — «<a
  // href="mailto:elena@velar-vr.ru">Елена</a>»), а getBodyText срезает теги
  // вместе с атрибутами.
  const rawHtml =
    email.body && typeof email.body === 'object' ? (email.body.html ?? '') : '';
  const text =
    `${subject}\n${getBodyText(email.body)}\n${email.content_preview ?? ''}\n${rawHtml}`.toLowerCase();
  // Домены-токены из текста (адреса, ссылки, подписи) → сверка с нашими.
  // Проверяем и точное совпадение, и суффикс («inst.mailganer.pro» цитирует
  // mailganer.pro). Токенизация вместо substring-поиска, чтобы «avelar-vr.ru»
  // не матчился как velar-vr.ru.
  const tokens = text.match(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/g) ?? [];
  for (const token of tokens) {
    if (ourDomains.has(token)) return { verdict: 'candidate', citedDomain: token };
    let rest = token;
    while (true) {
      const idx = rest.indexOf('.');
      if (idx < 0) break;
      rest = rest.slice(idx + 1);
      if (ourDomains.has(rest)) return { verdict: 'candidate', citedDomain: rest };
    }
  }
  return { verdict: 'no-citation' };
}

// ─── Наши рассыльные домены (все аккаунты воркспейса) ────────────────────────

interface AccountsInfo {
  domains: Set<string>;
  /** домен → ящики на нём (для account-campaign-mappings нужен email ящика). */
  mailboxesByDomain: Map<string, string[]>;
}

let accountsCache: { at: number; value: AccountsInfo } | null = null;

/**
 * ~1000 аккаунтов = ~11 страниц. Тянем их С ПАУЗАМИ: непейсированный бёрст в
 * 11 вызовов подряд (плюс 429-ретраи request()) на старте воркера совпадает с
 * первым тиком основного поллера и пробивает воркспейс-лимит ~10 RPM.
 */
async function fetchAllAccountsPaced(): Promise<{ email?: string }[]> {
  const pageDelay = Math.max(500, envNumber('INSTANTLY_OTHERS_PAGE_DELAY_MS', 2000));
  const out: { email?: string }[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 30; page++) {
    const res = await instantly.listAccounts({ limit: 100, starting_after: startingAfter });
    out.push(...((res.items ?? []) as { email?: string }[]));
    startingAfter = res.next_starting_after || undefined;
    if (!startingAfter) break;
    await sleep(pageDelay);
  }
  return out;
}

async function getOurAccountsInfo(): Promise<AccountsInfo> {
  const ttl = envNumber('INSTANTLY_OTHERS_DOMAIN_TTL_MS', 12 * 60 * 60 * 1000);
  if (accountsCache && Date.now() - accountsCache.at < ttl) return accountsCache.value;

  const accounts = await fetchAllAccountsPaced();
  const domains = new Set<string>();
  const mailboxesByDomain = new Map<string, string[]>();
  for (const acc of accounts) {
    const email = (acc.email ?? '').trim().toLowerCase();
    const domain = email.split('@')[1];
    if (!domain) continue;
    domains.add(domain);
    const list = mailboxesByDomain.get(domain);
    if (list) list.push(email);
    else mailboxesByDomain.set(domain, [email]);
  }
  const value = { domains, mailboxesByDomain };
  // Пустой список (блип API) не кэшируем: иначе вотчдог 12 часов слеп.
  if (domains.size > 0) accountsCache = { at: Date.now(), value };
  return value;
}

// ─── Атрибуция: цитируемый домен → квалифицируемые кампании ─────────────────

interface CampaignCandidate {
  campaignId: string;
  accountId: string;
}

const domainCandidatesCache = new Map<
  string,
  { at: number; ttl: number; value: CampaignCandidate[] }
>();

/**
 * Others-письмо не несёт campaign_id (проверено живьём: 500/500 пусто), а
 * контакт к моменту ответа часто уже удалён из Instantly (ежедневная ротация
 * баз) — lead-lookup не работает. Единственный устойчивый путь: цитируемый
 * домен → его ящики → account-campaign-mappings → пересечение с
 * квалифицируемыми кампаниями (сортировка: активные раньше завершённых,
 * свежие раньше старых). Прогрев-домены дают пусто.
 *
 * Осторожности (находки адверсариального ревью 16.07):
 *  - ящики домена перебираются ДО первого с непустым пересечением — ящик[0]
 *    может быть warmup-only при живой кампании на соседнем ящике;
 *  - null НЕ кэшируется, если квалифицируемая поверхность пуста (блип БД в
 *    getPortalLinkedCampaignIds деградирует её в пустые множества молча) —
 *    иначе 6-часовой негативный кэш переживает окно сканирования (~1ч) и
 *    молча теряет лидов;
 *  - негативный результат кэшируется КОРОТКО (дефолт 15 мин = 1 тик): «спец
 *    привязал проект → письмо подхватится» должно успевать в окно.
 */
async function getDomainCampaignCandidates(
  citedDomain: string,
  mailboxesByDomain: Map<string, string[]>,
  meter: ProbeMeter,
  eaccount?: string | null,
): Promise<CampaignCandidate[] | null> {
  // Ключ кэша включает eaccount: позитивная атрибуция идёт eaccount-первой и
  // точна для этого ящика; без этого кандидаты кампании одного ящика домена
  // затеняли бы кампанию другого (сабж-матч мимо → ложный дроп).
  const cacheKey = eaccount ? `${citedDomain}::${eaccount}` : citedDomain;
  const cached = domainCandidatesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;

  const mailboxes = mailboxesByDomain.get(citedDomain) ?? [];
  if (mailboxes.length === 0) return [];

  // eaccount-приоритет (диагноз валидации v1 17.07: 3 упущенных лида): ящик,
  // ПОЛУЧИВШИЙ ответ, пробуем первым — именно он слал кампанию, на которую
  // ответили. Без этого атрибуция шла по первым 4 ящикам пагинации и мазала
  // мимо (кампания живёт на 5+ ящике домена = перманентная слепая зона).
  const recipient = (eaccount ?? '').trim().toLowerCase();
  const ordered = recipient && mailboxes.includes(recipient)
    ? [recipient, ...mailboxes.filter((m) => m !== recipient)]
    : mailboxes;

  const qualifiable = await getCampaignsByAccountCached();
  const surfaceEmpty = ![...qualifiable.values()].some((s) => s.size > 0);
  if (surfaceEmpty) {
    // Либо кампаний реально ноль, либо БД деградировала — не отличить.
    // Возвращаем «неизвестно» без кэша: следующий тик перепроверит.
    workerLog('warn', 'qualifiable campaign surface is empty — attribution deferred, not cached');
    return null;
  }

  const candidates: CampaignCandidate[] = [];
  const seen = new Set<string>();
  let probed = 0;
  for (const mailbox of ordered) {
    if (probed >= MAX_MAILBOX_PROBES_PER_DOMAIN) break;
    // Бюджет/пейсинг маппинг-проб: warmup-волна без них давала десятки
    // неспейсенных вызовов подряд. Исчерпание — отложить, НЕ кэшировать.
    if (!(await meter.take())) return null;
    probed++;
    let items: AccountCampaignMappingItem[] = [];
    try {
      items = parseAccountCampaignMappingItems(await instantly.getAccountCampaignMappings(mailbox));
    } catch (err) {
      workerLog('warn', `account-campaign-mappings failed for ${mailbox} — attribution deferred`, err);
      return null; // транзиентно: НЕ кэшируем, попробуем на следующем тике
    }
    const sorted = items
      .map((m) => ({
        id: mappingCampaignId(m) ?? '',
        active: m.status === 1 ? 1 : 0,
        created: Date.parse(m.timestamp_created ?? '') || 0,
      }))
      .filter((m) => m.id)
      .sort((a, b) => b.active - a.active || b.created - a.created);
    for (const m of sorted) {
      if (seen.has(m.id)) continue;
      for (const [accountId, set] of qualifiable) {
        if (set.has(m.id)) {
          seen.add(m.id);
          candidates.push({ campaignId: m.id, accountId });
          break;
        }
      }
    }
    if (candidates.length > 0) break;
  }

  const negativeTtl = envNumber('INSTANTLY_OTHERS_NEGATIVE_TTL_MS', 15 * 60 * 1000);
  const positiveTtl = envNumber('INSTANTLY_OTHERS_MAPPING_TTL_MS', 6 * 60 * 60 * 1000);
  domainCandidatesCache.set(cacheKey, {
    at: Date.now(),
    ttl: candidates.length > 0 ? positiveTtl : negativeTtl,
    value: candidates,
  });
  return candidates;
}

// ─── Синтез тред-контекста ────────────────────────────────────────────────────

// campaignId → недавние sent-письма кампании (для сабж-матча + контекста ИИ),
// короткий TTL: новые отправки появляются, но темы-шаблоны стабильны.
const campaignSentCache = new Map<string, { at: number; emails: Email[] }>();

/**
 * Подметание + кап кэша sent-писем. TTL проверяется только при чтении, а одна
 * запись — до 100 ПОЛНЫХ писем с html (десятки КБ): бездонный Map за недели
 * аптайма = сотни МБ в heap. Воркер — общий с основным поллером процесс, его
 * OOM уронил бы оба контура (HIGH-находка swarm-ревью 25.07).
 */
function pruneCampaignSentCache(ttl: number): void {
  const now = Date.now();
  for (const [id, entry] of campaignSentCache) {
    if (now - entry.at >= ttl) campaignSentCache.delete(id);
  }
  const cap = Math.max(1, envNumber('INSTANTLY_OTHERS_SENT_CACHE_MAX', 50));
  if (campaignSentCache.size <= cap) return;
  const byAge = [...campaignSentCache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [id] of byAge.slice(0, campaignSentCache.size - cap)) {
    campaignSentCache.delete(id);
  }
}

async function fetchCampaignSent(
  campaignId: string,
  accountId: string,
  meter: ProbeMeter,
): Promise<Email[] | null> {
  const ttl = envNumber('INSTANTLY_OTHERS_SENT_TTL_MS', 10 * 60 * 1000);
  const cached = campaignSentCache.get(campaignId);
  if (cached && Date.now() - cached.at < ttl) return cached.emails;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Пейсинг (в т.ч. перед ретраем-на-пусто) и бюджет тика — в meter;
    // исчерпание бюджета = отложить (null), не дропать.
    if (!(await meter.take())) return null;
    let items: Email[];
    let rawCount = 0;
    try {
      const res = await instantly.listEmails(
        { campaign_id: campaignId, email_type: 'sent', limit: 100 },
        { accountId },
      );
      rawCount = (res.items ?? []).length;
      items = (res.items ?? []).filter((e) => (e.ue_type ?? 1) === 1 || (e.ue_type ?? 1) === 3);
    } catch (err) {
      workerLog('warn', `campaign sent fetch failed for ${campaignId} — attribution deferred`, err);
      return null; // транзиентно: не квалифицируем этот тик, но и не дропаем
    }
    if (items.length > 0 || rawCount > 0) {
      // Сначала вставка, ПОТОМ подметание: иначе кап срабатывал бы с лагом на
      // одну запись (prune видит кэш без текущей вставки).
      campaignSentCache.set(campaignId, { at: Date.now(), emails: items });
      pruneCampaignSentCache(ttl);
      return items;
    }
    // Известный флап Instantly: /emails под нагрузкой отдаёт пусто (тот же урок,
    // что с search=<email>). Один ретрай; пустой результат НЕ кэшируем — иначе
    // 10 минут слепоты по кампании = молча дропнутые реальные ответы (находка
    // ревью 25.07). Следующий тик перепроверит.
    if (attempt === 0) {
      workerLog('info', `campaign sent fetch returned empty for ${campaignId} — retrying once (possible API flap)`);
    }
  }
  return [];
}

// Нормализация темы: срезаем ведущие Re/Fwd, нижний регистр, схлопываем
// пробелы. «Re: RE: По вопросу…» → «по вопросу…».
function subjectStem(s: string | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/^(?:\s*(?:re|fw|fwd|ре|отв|пересылаемое сообщение)\s*[:>\-]\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// Плюс удаление персонализации «…»/"…" — тема-шаблон без имени компании.
function subjectTemplate(s: string | undefined): string {
  return subjectStem(s).replace(/[«"„“][^»"”]*[»"”]/g, '').replace(/\s+/g, ' ').trim();
}

const SUBJECT_MIN_PREFIX = 15;
// Общий префикс должен покрывать ≥70% меньшей темы И заканчиваться на границе
// слова: «Коммерческое предложение для ООО X» и «Коммерческое предложение —
// оптовым клиентам» делят 26 символов чистого клише, а «Стратегия роста продаж»
// и «стратегия роста промо» — 19 символов с обрывом посреди слова. Обе пары —
// типичные warmup-коллизии (MEDIUM-находки swarm-ревью 25.07).
const SUBJECT_PREFIX_MIN_COVERAGE = 0.7;
const WORD_CHAR_RE = /[0-9a-zа-яё]/i;

/**
 * Ответ считается настоящим ответом НА КАМПАНИЮ, если его тема = «Re: <тема,
 * которую кампания реально слала>» ИЛИ в теле ответа находится тема/текст нашего
 * исходящего. Отличает лида (даже с чужого/личного адреса) от warmup, у которого
 * тема своя, фейковая (валидировано 17.07 на живых данных: sale1@windguard
 * «По вопросу вентиляции» — префикс 23 с темами кампании; warmup «Стратегия
 * НеоСтиль Опт сессия», «Крипто-Фактор» — префикс 0). Возвращает совпавшее
 * исходящее (контекст для ИИ) или null.
 *
 * Матч (по убыванию силы сигнала):
 *  (а) равенство ШАБЛОНОВ без персонализации «…» (оба ≥8 симв.);
 *  (б) вложенность шаблонов, меньший ≥15 симв. — НЕзакавыченная персонализация;
 *      порог 15 отсекает короткие generic-темы («Re: Добрый день!» ≠ «Добрый день»);
 *  (в) общий префикс ≥15 симв. с покрытием ≥70% меньшей темы и концом на
 *      границе слова (отсекает коллизии generic-клише);
 *  (г) тема кампании дословно В ТЕЛЕ ответа (≥12 симв.) — спасает пустую или
 *      сбитую вручную тему (диагноз валидации v1 17.07: лиды с пустой темой);
 *  (д) цитата исходящего в теле ответа: нормализованное тело целиком или любая
 *      его строка ≥40 симв. — ручной тред с НОВОЙ темой узнаётся по контенту
 *      (диагноз v1: ручные треды ломали цепочку тем).
 *
 * Остаточный принятый риск: warmup-тема, почти дословно повторяющая длинный
 * generic-шаблон кампании, пройдёт — дальше решает ИИ (алерт при вердикте
 * «лид»; DM клиенту зажат clientDmOnlyOnLead).
 */

const SUBJECT_IN_BODY_MIN = 12;
const BODY_QUOTE_MIN = 40;

// Нормализация текста тела для матчей: срезаем `>`-цитирование построчно,
// нижний регистр, все пробельные последовательности в один пробел — почтовики
// кавычат оригинал построчно («> …»), из-за чего дословное включение цитаты
// ломалось (диагноз v1: чистка `>` при нормализации).
function normalizeBodyForMatch(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^\s*>+\s?/, ''))
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchReplyToCampaign(
  replySubject: string | undefined,
  replyBodyText: string,
  sent: Email[],
): Email | null {
  const rs = subjectStem(replySubject);
  const rt = subjectTemplate(replySubject);
  const bodyNorm = normalizeBodyForMatch(replyBodyText);
  for (const e of sent) {
    const ss = subjectStem(e.subject);
    if (ss) {
      if (rs.length >= 6) {
        const st = subjectTemplate(e.subject);
        const minTemplate = Math.min(rt.length, st.length);
        if (rt === st && minTemplate >= 8) return e;
        if (minTemplate >= SUBJECT_MIN_PREFIX && (rt.startsWith(st) || st.startsWith(rt))) return e;
        let i = 0;
        while (i < rs.length && i < ss.length && rs[i] === ss[i]) i++;
        if (
          i >= SUBJECT_MIN_PREFIX &&
          i >= SUBJECT_PREFIX_MIN_COVERAGE * Math.min(rs.length, ss.length) &&
          (i === rs.length ||
            i === ss.length ||
            !WORD_CHAR_RE.test(rs[i] ?? '') ||
            !WORD_CHAR_RE.test(ss[i] ?? ''))
        ) {
          return e;
        }
      }
      // (г) тема кампании дословно в теле ответа — пустая/сбитая тема не мешает.
      if (ss.length >= SUBJECT_IN_BODY_MIN && bodyNorm.includes(ss)) return e;
    }
    // (д) цитата исходящего в теле ответа: тело целиком (короткие письма) или
    // любая его строка ≥40 симв., процитированная в ответе.
    const sentBody = getBodyText(e.body);
    const sentBodyNorm = normalizeBodyForMatch(sentBody);
    if (sentBodyNorm.length >= BODY_QUOTE_MIN) {
      if (bodyNorm.includes(sentBodyNorm)) return e;
      for (const line of sentBody.split('\n')) {
        const ln = normalizeBodyForMatch(line);
        if (ln.length >= BODY_QUOTE_MIN && bodyNorm.includes(ln)) return e;
      }
    }
  }
  return null;
}

/**
 * fetchThreadContext ищет ответ ВНУТРИ кампании и Others-письма не увидит
 * (у того нет campaign_id). Поэтому контекст собираем сами: replyEmail = само
 * Others-письмо, lastOutbound = ИМЕННО то исходящее, на которое лид ответил
 * (совпавшее по теме — точный контекст пича для ИИ), а mailbox-set — все ящики
 * кампании (для cross-client guard в qualifyOneReply).
 */
function buildOthersThreadContext(
  reply: Email,
  matchedOutreach: Email | null,
  campaignMailboxes: string[],
): ThreadContext {
  return {
    replyEmail: reply,
    threadEmails: matchedOutreach ? [matchedOutreach, reply] : [reply],
    lastOutbound: matchedOutreach,
    campaignOutboundMailboxes: campaignMailboxes,
  };
}

// ─── Основной тик ─────────────────────────────────────────────────────────────

export async function pollOthersOnce(): Promise<number> {
  if (!supabaseAdmin) {
    workerLog('warn', 'supabaseAdmin not configured — skipping');
    return 0;
  }
  const db = supabaseAdmin;
  const apiKey = API_KEY();
  if (!apiKey) {
    workerLog('warn', 'No AI API key — skipping');
    return 0;
  }

  const { domains, mailboxesByDomain } = await getOurAccountsInfo();
  if (domains.size === 0) {
    workerLog('warn', 'No sending domains discovered — skipping tick');
    return 0;
  }

  // 1. Свежие страницы Others (main-воркспейс: там живут прогрев и кампании).
  const maxPages = Math.max(1, Math.min(5, envNumber('INSTANTLY_OTHERS_PAGES', 2)));
  const pageDelay = Math.max(500, envNumber('INSTANTLY_OTHERS_PAGE_DELAY_MS', 2000));
  const skips: Record<string, number> = {};
  let scanned = 0;
  const rawCandidates: { email: Email; citedDomain: string }[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(pageDelay);
    const res = await instantly.listEmails({
      email_type: 'received',
      mode: 'emode_others',
      limit: OTHERS_PAGE_SIZE,
      starting_after: startingAfter,
    });
    const items = res.items ?? [];
    scanned += items.length;
    for (const email of items) {
      const screened = screenOthersEmail(email, domains);
      if (screened.verdict === 'candidate' && screened.citedDomain) {
        rawCandidates.push({ email, citedDomain: screened.citedDomain });
      } else {
        skips[screened.verdict] = (skips[screened.verdict] ?? 0) + 1;
      }
    }
    startingAfter = res.next_starting_after || undefined;
    if (!startingAfter || items.length === 0) break;
  }

  if (rawCandidates.length === 0) {
    workerLog('info', `Scanned ${scanned} Others email(s): no candidates (${JSON.stringify(skips)})`);
    return 0;
  }

  // 2. Дедуп по instantly_email_id — ПЕРЕД схлопыванием (порядок как в
  //    поллере: 3a → 3b). Иначе уже обработанное новейшее письмо отправителя
  //    вечно затеняло бы его более раннее НЕобработанное (находка ревью).
  const ids = rawCandidates.map((c) => c.email.id).filter(Boolean);
  const existingIds = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await db
      .from('instantly_lead_qualifications')
      .select('instantly_email_id')
      .in('instantly_email_id', ids.slice(i, i + 50));
    if (error) {
      // Не зная, что уже обработано, продолжать нельзя: повторный AI-вердикт и
      // ПОВТОРНЫЙ АЛЕРТ по уже разобранному письму хуже 15-минутной задержки.
      workerLog('warn', `dedup query failed — deferring tick: ${error.message}`);
      return 0;
    }
    for (const r of data ?? []) {
      existingIds.add((r as { instantly_email_id: string }).instantly_email_id);
    }
  }
  const unprocessed = rawCandidates.filter((c) => c.email.id && !existingIds.has(c.email.id));

  // 3. Новейшее письмо на отправителя+домен. Ключ ВКЛЮЧАЕТ citedDomain: один
  //    человек мог ответить на аутрич двух разных клиентов в одном окне.
  const latestByKey = new Map<string, { email: Email; citedDomain: string }>();
  const ts = (e: Email) => new Date(e.timestamp_email ?? e.timestamp_created ?? 0).getTime();
  for (const c of unprocessed) {
    const key = `${(c.email.from_address_email ?? '').toLowerCase()}::${c.citedDomain}`;
    const prev = latestByKey.get(key);
    if (!prev || ts(c.email) > ts(prev.email)) latestByKey.set(key, c);
  }
  const fresh = [...latestByKey.values()];
  workerLog(
    'info',
    `Scanned ${scanned} Others email(s): ${rawCandidates.length} candidate(s), ${fresh.length} new (${JSON.stringify(skips)})`,
  );
  if (fresh.length === 0) return 0;

  // 4. Квалификация. Потолок считает ПОПЫТКИ квалификации (вызовы ИИ), а не
  //    префикс списка: неатрибуцируемые скипы (Coldy/Trigga-домены новее по
  //    списку) дёшевы и не должны выдавливать реальный ответ из слотов.
  const maxPerTick = Math.max(1, envNumber('INSTANTLY_OTHERS_MAX_PER_TICK', 5));
  const interDelay = Math.max(1000, envNumber('INSTANTLY_LEADS_INTER_REPLY_DELAY_MS', 3500));
  const probeDelay = Math.max(200, envNumber('INSTANTLY_OTHERS_PROBE_DELAY_MS', 800));
  // Бюджет Instantly-проб на тик (INSTANTLY_OTHERS_PROBE_BUDGET): типичный тик
  // ест ~4-8 вызовов, warmup-волна без потолка дала бы сотни поверх ~10 RPM
  // основного поллера. Исчерпание = отложить остаток на следующий тик: письма
  // в окне сканирования его переживут, негативные кэши по ним не пишутся.
  const probeBudget = Math.max(1, envNumber('INSTANTLY_OTHERS_PROBE_BUDGET', 25));
  const meter = makeProbeMeter(probeBudget, probeDelay);
  let attempts = 0;
  let processed = 0;
  let warmupDropped = 0;
  for (const { email, citedDomain } of fresh) {
    if (attempts >= maxPerTick) break;
    if (meter.exhausted()) {
      workerLog('info', `probe budget (${probeBudget}/tick) exhausted — remaining candidate(s) deferred to next tick`);
      break;
    }
    const sender = (email.from_address_email ?? '').toLowerCase();

    const candidates = await getDomainCampaignCandidates(
      citedDomain,
      mailboxesByDomain,
      meter,
      (email.eaccount ?? '').trim().toLowerCase() || null,
    );
    if (candidates === null) continue; // деградация — перепроверим на следующем тике
    if (candidates.length === 0) {
      // Домен без квалифицируемой кампании = Coldy/Trigga-прогрев или ещё не
      // привязанная кампания. Ничего не пишем: негативный кэш короткий, при
      // привязке проекта письмо (пока оно в окне сканирования) подхватится.
      workerLog('info', `No qualifiable campaign for cited domain ${citedDomain} (from ${sender}) — skipped`);
      continue;
    }

    // ГЛАВНАЯ отсечка warmup (инцидент 17.07: вотчдог штамповал прогрев в лиды).
    // Квалифицируем ТОЛЬКО если тема ответа = «Re: <тема, которую кампания реально
    // слала>». Логика: настоящий лид, даже отвечая с чужого/личного адреса,
    // сохраняет тему нашего письма; warmup — переписка наших ящиков с ЧУЖИМИ
    // warmup-персонами (momlife.work) — цитирует наш домен (⇒ прошёл контент-матч),
    // но тема у него своя, фейковая («Стратегия НеоСтиль Опт сессия»), которой
    // кампания никогда не слала. То же отсекает чужие рассылки (marketing@saas).
    // ВАЖНО: НЕ «слали ли отправителю» — лид отвечает с ДРУГОГО адреса (в этом
    // весь смысл Others), проверка по адресу выкинула бы его. Проверка по ТЕМЕ
    // работает с любого адреса.
    //
    // Проба заодно выбирает ПРАВИЛЬНУЮ кампанию: у пул-домена их несколько (в т.ч.
    // разных клиентов) — берём ту, чьи темы совпали. Пейсинг/бюджет проб — в meter.
    let chosen: CampaignCandidate | null = null;
    let matchedOutreach: Email | null = null;
    let campaignMailboxes: string[] = [];
    let sentFetchFailed = false;
    for (const cand of candidates.slice(0, MAX_CAMPAIGN_PROBES_PER_EMAIL)) {
      const sent = await fetchCampaignSent(cand.campaignId, cand.accountId, meter);
      if (sent === null) {
        sentFetchFailed = true; // транзиентный сбой fetch — не роняем в дроп
        continue;
      }
      const m = matchReplyToCampaign(email.subject, getBodyText(email.body), sent);
      if (m) {
        chosen = cand;
        matchedOutreach = m;
        campaignMailboxes = [
          ...new Set(sent.map((e) => (e.eaccount ?? '').trim().toLowerCase()).filter(Boolean)),
        ];
        break;
      }
    }
    if (!chosen) {
      if (sentFetchFailed) continue; // не смогли проверить тему → отложить, НЕ дроп
      // Тема не совпала ни с одной кампанией домена → это не ответ на наш аутрич
      // (warmup / чужая рассылка). Строку НЕ пишем: not_lead на весь warmup-поток
      // = лишние вставки, а короткий кэш атрибуции + выход письма из окна уберут.
      warmupDropped++;
      workerLog('info', `Reply subject "${email.subject ?? ''}" matches no campaign of ${citedDomain} (from ${sender}) — warmup/non-reply, skipped`);
      continue;
    }

    attempts++;
    if (attempts > 1) await sleep(interDelay);

    const reply: Email = { ...email, campaign_id: chosen.campaignId };
    // Детектор сироты: у Others-письма campaign_id пуст (проверено живьём:
    // 500/500) или не совпадает с атрибутированным — Instantly письмо НЕ
    // привязал (ответ с другого адреса лида, сломанные заголовки треда), и
    // атрибуция сделана НАМИ по цитируемому домену. Помечаем честно: DM
    // скажет «Ответ вне треда кампании» (а не «по вашей кампании»), а кабинет
    // покажет его в блоке «Ответы вне кампании» по reply_out_of_campaign.
    const outOfCampaign = !email.campaign_id || email.campaign_id !== chosen.campaignId;
    try {
      const ctx = buildOthersThreadContext(reply, matchedOutreach, campaignMailboxes);
      await qualifyOneReply(db, reply, apiKey, chosen.accountId, ctx, {
        clientDmOnlyOnLead: true,
        outOfCampaign,
        // A subject/body match is authoritative only when this mailbox has a
        // single qualifiable campaign. With several candidates the first match
        // may be a shared template, so ownership must run its cross-owner
        // evidence checks instead of trusting probe order.
        prefetchedParentMatched: candidates.length === 1,
      });
      processed++;
      workerLog(
        'info',
        `Qualified Others reply from ${sender} (cited ${citedDomain} → campaign ${chosen.campaignId})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const emailId = email.id ?? '';
      workerLog('error', `Failed to qualify Others reply ${emailId}`, err);

      // Others scans only a bounded provider window. Persist the same durable
      // generated needs_review state as the main poller: otherwise a long DB,
      // ownership or AI outage lets the reply fall out of the scan before it
      // ever reaches a specialist.
      if (emailId && isTransientQualifyError(message)) {
        const { error: retryError } = await persistTransientQualificationRetry(
          db,
          reply,
          message,
          {
            campaignId: chosen.campaignId,
            outOfCampaign,
            eaccount: email.eaccount ?? null,
            lastOutbound: matchedOutreach,
          },
        );
        if (retryError) {
          workerLog('error', `Could not persist retryable Others reply ${emailId}: ${retryError.message}`);
        } else {
          workerLog('warn', `Deferred Others reply ${emailId} to durable qualification retry`);
        }
        continue;
      }
      const { error: insErr } = await db.from('instantly_lead_qualifications').insert({
        campaign_id: chosen.campaignId,
        lead_email: sender || 'unknown',
        thread_id: email.thread_id,
        instantly_email_id: email.id,
        status: 'error',
        error_message: message.slice(0, 500),
        // Окно «код без миграции»: без колонок — иначе error-insert упадёт и
        // видимость сбоя потеряется (тот же гейт, что в qualifyOneReply).
        ...((await strayColumnsSupported(db))
          ? { reply_out_of_campaign: outOfCampaign, eaccount: (email.eaccount ?? '').trim() || null }
          : {}),
      });
      if (insErr) workerLog('warn', `error-row insert failed for ${email.id}: ${insErr.message}`);
    }
  }

  workerLog(
    'info',
    `Others tick done: ${processed} qualified, ${warmupDropped} dropped (subject matches no campaign = warmup/non-reply)`,
  );
  return processed;
}

// Внутренности для read-only валидации на живых данных
// (app/scripts/others-watchdog-validate.ts) и для тестов. Не расширять без нужды.
export const _private = {
  makeProbeMeter,
  getOurAccountsInfo,
  getDomainCampaignCandidates,
  fetchCampaignSent,
  matchReplyToCampaign,
};
