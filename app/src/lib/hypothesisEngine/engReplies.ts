/**
 * ENG: ответы на кампании клиента для кабинета (/client/eng/replies) — только
 * чтение, свежие сверху, страницами.
 *
 * ОТКУДА. Из instantly_activity_events (основная БД): приёмник вебхуков
 * /api/instantly/webhook/<account> складывает туда каждое событие
 * reply_received КАЖДОГО настроенного воркспейса рассыльщика (регистрация —
 * lib/instantly/activityWebhooks.ts, все аккаунты INSTANTLY_API_KEY +
 * INSTANTLY_ACCOUNTS_JSON, без фильтра по кампаниям) вместе с исходным payload
 * в `raw`. Ноль обращений к рассыльщику на чтении, ни одного LIST /emails.
 *
 * ПОЧЕМУ НЕ ОСТАЛЬНЫЕ ХРАНИЛИЩА. RU-кабинет читает ответы живым LIST /emails по
 * каждой кампании + хвост instantly_reply_intake. Intake и
 * instantly_lead_qualifications пишет только квалификатор, и только по
 * кампаниям своей поверхности (getCampaignsByAccountCached: связки проектов в
 * 'main' и client_instantly_access по аккаунтам). Кампаний ENG там нет —
 * запуск ENG ни ту, ни другую связку не пишет (engCampaignSending.ts), — и
 * добавлять их туда нельзя: тогда ответы ENG пошли бы в RU-квалификатор
 * (платный ИИ, алерты специалистам, DM RU-клиентам). Датасет instantly_dataset
 * синкается раз в сутки и одним ключом (INSTANTLY_EXPORT_API_KEY, фолбэк —
 * ключ 'main'), то есть одного воркспейса.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Хранилище только вперёд, без бэкфилла: ответ, пришедший,
 * пока вебхук воркспейса не был зарегистрирован или был выключен рассыльщиком
 * (status -1 после сбоев доставки — его чинит только повторный вызов
 * /api/instantly/activity/register), сюда не попадёт. Ответ, который рассыльщик
 * к кампании не привязал (ответили с другого адреса, сломанные заголовки
 * треда), события reply_received с этой кампанией не даёт — его здесь тоже нет.
 *
 * ВЛАДЕЛЕЦ. Кампании — только из he_templates.launch_info шаблонов вертикалей
 * проектов, которые вызывающий уже отобрал по владельцу (created_by = клиент,
 * роут api/client/eng/replies). Чужой campaign_id сюда попасть не может.
 *
 * ЧУЖОЙ ЯЩИК — то же правило, что у каждой RU-поверхности ответов
 * (clientCampaignReplies/foreignMailboxFilter.ts). Рассыльщик привязывает
 * входящее письмо к кампании ТОЛЬКО по адресу отправителя и не смотрит, на чей
 * ящик оно пришло: письмо лида, пришедшее на ящик ДРУГОГО клиента общего
 * воркспейса (account-2 делят ENG и RU), приходит событием этой кампании. Без
 * проверки клиент видел бы чужую переписку. Поэтому у каждого события берётся
 * ящик-получатель — поле `email_account` payload вебхука (его имя у события
 * рассыльщика; запасное — `eaccount`, имя того же ящика в письме LIST /emails,
 * которое читает RU-фильтр), — и строка, чей ящик известен и не входит в
 * ящики клиента (readHeEngReplyMailboxes), не показывается. Решение — ровно
 * RU-функцией partitionForeignEmails (импорт, а не копия), значит, и всё её
 * поведение:
 *  - ящик-получатель неизвестен (поля нет, пусто) — ответ ПОКАЗЫВАЕТСЯ: так
 *    RU поступает с письмом без eaccount («нечего проверять»);
 *  - набор ящиков клиента пуст — показывается всё: так RU поступает, когда ни
 *    email_list кампании, ни пула клиента нет (fail-open).
 * Чем ENG отличается от RU, и почему. RU берёт ящики из живого email_list
 * кампании (запрос к рассыльщику) и при его сбое показывает всё; здесь
 * рассыльщика не зовём, а набор целиком из наших БД, и НЕпрочитанный набор —
 * отказ страницы (ответ ok:false → 500 роута), а не показ всего и не фильтр по
 * половине: половина молча прятала бы живые ответы, показ всего — утечка.
 *
 * ТЕКСТ. Поля payload рассыльщика: reply_subject, reply_text, reply_html,
 * reply_text_snippet, email_account — поля события reply_received по его
 * документации; на сохранённых строках не сверены (до деплоя — одно чтение
 * ключей `raw`). Наружу уходит ТОЛЬКО простой текст: reply_text, иначе
 * reply_html, переведённый в текст здесь же (heEngReplyHtmlToText; HTML
 * клиенту не отдаём никогда), иначе reply_text_snippet — тогда это начало
 * ответа (`text_partial`). Ни одного поля нет — text: null, и кабинет так и
 * говорит.
 *
 * ПОЧЕМУ HTML РАЗБИРАЕТСЯ ЗДЕСЬ, А НЕ ОБЩИМ extractBodyText. HTML ответа пишет
 * отправитель, то есть кто угодно, а разбор идёт на потоке запроса. Общий
 * htmlToText (clientCampaignReplies/mapEmail.ts) построен на регулярках, время
 * которых растёт квадратично на подобранном входе: 200 000 символов «<» без
 * «>» — 56 с, столько же пробелов без перевода строки — 59 с, ~33 000
 * незакрытых «<style» — 8 с (замер этой правки). Его не трогаем (это RU-путь), а
 * разбор ниже — те же правила теми же шагами (результат совпадает с
 * extractBodyText), но каждый шаг линеен: каждый символ смотрится константное
 * число раз при любом входе.
 *
 * Модуль НЕ БРОСАЕТ: каждая функция отвечает значением.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidUuid } from '@/lib/apiValidation';
import { normalizeMailbox, partitionForeignEmails } from '@/lib/clientCampaignReplies/foreignMailboxFilter';
import { parseLaunchInfo } from './launchHandoff';
import { toClientEngCampaignName } from './clientEngProjection';

const HE_ENG_ACTIVITY_TABLE = 'instantly_activity_events';

/** Ответов на странице по умолчанию и потолок параметра limit. */
export const HE_ENG_REPLIES_PAGE_SIZE = 20;
export const HE_ENG_REPLIES_MAX_PAGE_SIZE = 50;

/**
 * Кампаний в одном `in(...)`: id — uuid (36 символов), и сотня с лишним
 * упирается в длину строки запроса PostgREST. Больше — несколько запросов,
 * склейка по тому же порядку.
 */
const CAMPAIGN_CHUNK = 80;

/**
 * Сколько окон событий читает одна страница, чтобы набрать `limit` ответов,
 * когда часть окна скрыта как чужая (или повтор доставки). Не набралось за
 * столько окон — страница короче, курсор `next` ведёт дальше.
 */
const FILL_ROUNDS = 3;

/**
 * Потолок строк пула ящиков на чтение: проектов в роуте не больше 100, ящиков
 * на проект — 3 по умолчанию. Упёрлись в потолок — набор мог прочитаться не
 * целиком, и это отказ (см. шапку: фильтр по половине набора не делается).
 */
const POOL_ROWS_CAP = 1000;

/** Потолки того, что уходит в браузер. */
const MAX_TEXT_CHARS = 20_000;
const MAX_SUBJECT_CHARS = 500;
/** HTML ответа разбирается не длиннее этого (дальше — цитаты и подписи). */
const MAX_HTML_SCAN_CHARS = 200_000;

/* ─────────────── Кампании клиента ─────────────── */

export interface HeEngReplyCampaign {
  campaignId: string;
  /** Имя кампании для клиента (toClientEngCampaignName); '' — имени в записи нет. */
  campaignName: string;
  verticalName: string;
}

type ProjectRow = { id: unknown };
type VerticalRow = { id: unknown; project_id: unknown; name?: unknown };
type TemplateRow = { vertical_id: unknown; launch_info: unknown };

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Вертикали проектов из `projects` → имя вертикали (чужие отброшены). */
function ownVerticalNames(projects: ReadonlyArray<ProjectRow>, verticals: ReadonlyArray<VerticalRow>): Map<string, string> {
  const projectIds = new Set(projects.map((p) => text(p.id)));
  return new Map(
    verticals.filter((v) => projectIds.has(text(v.project_id))).map((v) => [text(v.id), text(v.name)]),
  );
}

/**
 * Кампании записей о запуске: список `campaigns` (основная + сегментные), а у
 * записи до сплита — скалярная основная. Повтор id — первая встреченная.
 * Чистая функция: строки уже отобраны по владельцу.
 */
export function heEngReplyCampaignsFromRows(
  projects: ReadonlyArray<ProjectRow>,
  verticals: ReadonlyArray<VerticalRow>,
  templates: ReadonlyArray<TemplateRow>,
): HeEngReplyCampaign[] {
  const verticalName = ownVerticalNames(projects, verticals);
  const out = new Map<string, HeEngReplyCampaign>();
  for (const t of templates) {
    const vertical = verticalName.get(text(t.vertical_id));
    if (vertical === undefined) continue;
    const launch = parseLaunchInfo(t.launch_info);
    if (!launch) continue;
    const list = launch.campaigns?.length
      ? launch.campaigns.map((c) => ({ id: c.campaign_id, name: c.campaign_name }))
      : [{ id: launch.campaign_id, name: launch.campaign_name }];
    for (const c of list) {
      if (!c.id || out.has(c.id)) continue;
      out.set(c.id, {
        campaignId: c.id,
        campaignName: toClientEngCampaignName(c.name),
        verticalName: vertical,
      });
    }
  }
  return [...out.values()];
}

/**
 * Пресеты, с которыми шли запуски (launch_info.preset_id), — для набора ящиков
 * клиента. Только uuid: иное значение в `in(id, …)` уронило бы весь запрос.
 * Чистая функция: строки уже отобраны по владельцу.
 */
export function heEngReplyPresetIdsFromRows(
  projects: ReadonlyArray<ProjectRow>,
  verticals: ReadonlyArray<VerticalRow>,
  templates: ReadonlyArray<TemplateRow>,
): string[] {
  const verticalName = ownVerticalNames(projects, verticals);
  const out = new Set<string>();
  for (const t of templates) {
    if (!verticalName.has(text(t.vertical_id))) continue;
    const presetId = parseLaunchInfo(t.launch_info)?.preset_id ?? '';
    if (presetId && isValidUuid(presetId)) out.add(presetId);
  }
  return [...out];
}

/**
 * Кампании запусков проектов клиента и пресеты этих запусков. `projects` — уже
 * его (created_by), отбор по владельцу делает роут.
 */
export async function readHeEngReplyCampaigns(
  db: SupabaseClient,
  projects: ReadonlyArray<{ id: string }>,
): Promise<{ ok: true; campaigns: HeEngReplyCampaign[]; presetIds: string[] } | { ok: false; error: unknown }> {
  if (projects.length === 0) return { ok: true, campaigns: [], presetIds: [] };
  const { data: verticals, error: verticalsError } = await db
    .from('he_verticals')
    .select('id, project_id, name')
    .in('project_id', projects.map((p) => p.id));
  if (verticalsError) return { ok: false, error: verticalsError };
  const verticalRows = (verticals ?? []) as VerticalRow[];
  const verticalIds = verticalRows.map((v) => v.id).filter((id): id is string => typeof id === 'string' && id !== '');
  if (verticalIds.length === 0) return { ok: true, campaigns: [], presetIds: [] };
  const { data: templates, error: templatesError } = await db
    .from('he_templates')
    .select('vertical_id, launch_info')
    .in('vertical_id', verticalIds)
    .not('launch_info', 'is', null);
  if (templatesError) return { ok: false, error: templatesError };
  const templateRows = (templates ?? []) as TemplateRow[];
  return {
    ok: true,
    campaigns: heEngReplyCampaignsFromRows(projects, verticalRows, templateRows),
    presetIds: heEngReplyPresetIdsFromRows(projects, verticalRows, templateRows),
  };
}

/* ─────────────── Ящики клиента ─────────────── */

/**
 * Ящики, которые принимают ответы на кампании клиента (адреса, lowercase):
 *  1. he_sending_pool, строки проектов клиента — в ЛЮБОМ статусе (фильтра по
 *     status нет). Оговорка схемы: project_id есть только у 'assigned' (CHECK
 *     миграции 20261011_0001), возврат в пул его стирает, поэтому строки
 *     возвращённых ящиков по проекту не найти. Возврат проекта С ЗАПУСКОМ
 *     функция he_sending_pool_release запрещает ('launched'), то есть ящик,
 *     из которого кампания писала, за проектом остаётся; вернуть его можно
 *     только руками в БД — тогда его ответы держит пункт 2, пока ящик в пресете;
 *  2. пресеты запусков (launch_info.preset_id; запуск пишет только id, список
 *     ящиков в записи о запуске не сохраняется) — их ТЕКУЩИЙ email_account_ids,
 *     и только пресеты этого клиента (client_user_id): ящики чужого пресета в
 *     набор не попадают никогда. Покрывает запуски до пула (ящики пресета не из
 *     пула).
 * RU-пул (foreignMailboxFilter.getClientMailboxPool) читает ещё журнал
 * client_campaign_launches — ENG-запуск его не пишет.
 *
 * Любой сбой чтения — ok:false (см. шапку, «Чем ENG отличается от RU»).
 */
export async function readHeEngReplyMailboxes(
  db: SupabaseClient,
  instantlyDb: SupabaseClient | null,
  input: { userId: string; projectIds: ReadonlyArray<string>; presetIds: ReadonlyArray<string> },
): Promise<{ ok: true; mailboxes: Set<string> } | { ok: false; error: unknown }> {
  const mailboxes = new Set<string>();
  const add = (value: unknown): void => {
    const box = normalizeMailbox(typeof value === 'string' ? value : null);
    if (box) mailboxes.add(box);
  };
  if (input.projectIds.length > 0) {
    const { data, error } = await db
      .from('he_sending_pool')
      .select('email')
      .in('project_id', [...input.projectIds])
      .limit(POOL_ROWS_CAP);
    if (error) return { ok: false, error };
    const rows = (data ?? []) as Array<{ email?: unknown }>;
    if (rows.length >= POOL_ROWS_CAP) {
      return { ok: false, error: new Error(`he_sending_pool: ${rows.length} rows hit the read cap ${POOL_ROWS_CAP}`) };
    }
    for (const row of rows) add(row.email);
  }
  if (input.presetIds.length > 0) {
    if (!instantlyDb) return { ok: false, error: new Error('instantly DB is not configured: launch presets unreadable') };
    const { data, error } = await instantlyDb
      .from('client_campaign_presets')
      .select('email_account_ids')
      .in('id', [...input.presetIds])
      .eq('client_user_id', input.userId);
    if (error) return { ok: false, error };
    for (const row of (data ?? []) as Array<{ email_account_ids?: unknown }>) {
      if (Array.isArray(row.email_account_ids)) row.email_account_ids.forEach(add);
    }
  }
  return { ok: true, mailboxes };
}

/* ─────────────── HTML → текст (линейно) ─────────────── */

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

function decodeCodePoint(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** [A-Za-z0-9_] — граница `\b` после имени тега. */
function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
  );
}

/** Имя `name` (lowercase) в `s` с позиции `at`, без учёта регистра. */
function nameAt(s: string, at: number, name: string): boolean {
  return at + name.length <= s.length && s.slice(at, at + name.length).toLowerCase() === name;
}

const RAW_TEXT_TAGS = ['style', 'script'] as const;
type RawTextTag = (typeof RAW_TEXT_TAGS)[number];

/** `<style…` / `<script…` с границей слова после имени — какой из двух, иначе null. */
function rawTextOpenerAt(s: string, lt: number): RawTextTag | null {
  for (const name of RAW_TEXT_TAGS) {
    const end = lt + 1 + name.length;
    if (nameAt(s, lt + 1, name) && !(end < s.length && isWordCode(s.charCodeAt(end)))) return name;
  }
  return null;
}

/**
 * Конец (индекс после `>`) первого `</name\s*>` начиная с `from`; -1 — нет.
 * Каждый `</` смотрится один раз, пробелы после имени — до первого не-пробела.
 */
function rawTextCloseEnd(s: string, from: number, name: RawTextTag): number {
  let at = from;
  for (;;) {
    const lt = s.indexOf('</', at);
    if (lt === -1) return -1;
    if (nameAt(s, lt + 2, name)) {
      let j = lt + 2 + name.length;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      if (s.charCodeAt(j) === 62 /* > */) return j + 1;
    }
    at = lt + 2;
  }
}

/**
 * Блоки `<style…>…</style>` и `<script…>…</script>` целиком (их содержимое —
 * CSS и код почтовика, не текст ответа). То же, что регулярка
 * /<(style|script)\b[\s\S]*?<\/\1\s*>/gi, но за линейное время: у тега без
 * закрывающего тега закрывающего нет и дальше по строке, и второй раз его не
 * ищем — именно этот повторный поиск давал квадрат (~0,9 с на подобранный
 * ответ). Незакрытый блок остаётся текстом, как у регулярки.
 */
export function heEngStripStyleScript(html: string): string {
  const unclosed = new Set<RawTextTag>();
  const parts: string[] = [];
  let copied = 0;
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<', at);
    if (lt === -1) break;
    at = lt + 1;
    const name = rawTextOpenerAt(html, lt);
    if (!name || unclosed.has(name)) continue;
    const end = rawTextCloseEnd(html, lt + 1 + name.length, name);
    if (end === -1) {
      unclosed.add(name);
      continue;
    }
    parts.push(html.slice(copied, lt));
    copied = end;
    at = end;
  }
  parts.push(html.slice(copied));
  return parts.join('');
}

/** Строка без хвостовых пробелов и табов — циклом, не регуляркой (`[ \t]+$` квадратична). */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0) {
    const code = line.charCodeAt(end - 1);
    if (code !== 32 && code !== 9) break;
    end -= 1;
  }
  return end === line.length ? line : line.slice(0, end);
}

/** Индекс первого не-пробела (`\s`) с позиции `i`. */
function skipSpaces(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j += 1;
  return j;
}

/** Совпадение тега с «<» в позиции lt: конец (индекс после него), NONE — здесь нет, STOP — дальше нет нигде. */
const NONE = -1;
const STOP = -2;

/**
 * Один проход «как replace(/<…>/g, replacement)»: совпадения ищутся слева
 * направо, только с «<», не перекрываются, поиск продолжается после замены —
 * ровно семантика глобальной регулярки. `match` получает позицию «<» и
 * поиск «первого > не раньше from»; этот поиск монотонный, с запоминанием, —
 * поэтому «<» без «>» дальше (то, на чём регулярка тратит квадрат) стоит здесь
 * один проход до конца строки на весь проход, а не на каждый «<».
 */
function replaceTags(
  s: string,
  match: (lt: number, gtFrom: (from: number) => number) => number,
  replacement: string,
): string {
  let gt = -2;
  let lastFrom = -1;
  const gtFrom = (from: number): number => {
    if (from < lastFrom) return s.indexOf('>', from); // проходы ниже так не зовут; без кеша — на всякий случай
    lastFrom = from;
    if (gt === -1) return -1;
    if (gt < from) gt = s.indexOf('>', from);
    return gt;
  };
  const parts: string[] = [];
  let copied = 0;
  let lt = s.indexOf('<');
  while (lt !== -1) {
    const end = match(lt, gtFrom);
    if (end === STOP) break;
    if (end === NONE) {
      lt = s.indexOf('<', lt + 1);
      continue;
    }
    parts.push(s.slice(copied, lt), replacement);
    copied = end;
    lt = s.indexOf('<', end);
  }
  parts.push(s.slice(copied));
  return parts.join('');
}

/** `/<br\s*\/?>/gi`. */
function brAt(s: string, lt: number): number {
  if (!nameAt(s, lt + 1, 'br')) return NONE;
  let j = skipSpaces(s, lt + 3);
  if (s.charCodeAt(j) === 47 /* / */) j += 1;
  return s.charCodeAt(j) === 62 /* > */ ? j + 1 : NONE;
}

/** `/<\/p>\s*<p[^>]*>/gi`. */
function pBoundaryAt(s: string, lt: number, gtFrom: (from: number) => number): number {
  if (!nameAt(s, lt + 1, '/p>')) return NONE;
  const j = skipSpaces(s, lt + 4);
  if (s.charCodeAt(j) !== 60 /* < */ || !nameAt(s, j + 1, 'p')) return NONE;
  const gt = gtFrom(j + 2);
  return gt === -1 ? STOP : gt + 1;
}

/** `/<\/?(div|p|li)[^>]*>/gi`. */
function blockTagAt(s: string, lt: number, gtFrom: (from: number) => number): number {
  const at = s.charCodeAt(lt + 1) === 47 /* / */ ? lt + 2 : lt + 1;
  const name = nameAt(s, at, 'div') ? 3 : nameAt(s, at, 'p') ? 1 : nameAt(s, at, 'li') ? 2 : 0;
  if (name === 0) return NONE;
  const gt = gtFrom(at + name);
  return gt === -1 ? STOP : gt + 1;
}

/** `/<[^>]+>/g`. */
function anyTagAt(lt: number, gtFrom: (from: number) => number): number {
  const gt = gtFrom(lt + 1);
  if (gt === -1) return STOP;
  return gt === lt + 1 ? NONE : gt + 1;
}

/**
 * HTML ответа → простой текст: ровно правила общего htmlToText (mapEmail.ts)
 * в том же порядке — `<br>` → «\n», `</p>` + пробелы + `<p…>` → «\n»,
 * `<div…>` / `<p…>` / `<li…>` (и закрывающие; имя — префиксом, как у
 * регулярки) → «\n», прочие теги убираются, сущности (&#N; &#xN;
 * именованные, &amp; последним) раскрываются, хвостовые пробелы строк и
 * больше двух пустых строк подряд убираются, края обрезаются. Каждый проход
 * тегов — replaceTags (линейный); сущности — те же регулярки (они линейны:
 * каждая начинается с «&», и прогоны цифр и букв за разными «&» не
 * пересекаются); хвостовые пробелы — циклом. До этого блоки <style>/<script>
 * (heEngStripStyleScript). Отличие от `extractBodyText({ html })` одно:
 * пустой результат — '' вместо null (вызывающий читает оба как «текста
 * нет»). Вход — не длиннее MAX_HTML_SCAN_CHARS. Чистая функция.
 */
export function heEngReplyHtmlToText(html: string): string {
  let s = heEngStripStyleScript(html.slice(0, MAX_HTML_SCAN_CHARS));
  s = replaceTags(s, (lt) => brAt(s, lt), '\n');
  s = replaceTags(s, (lt, gtFrom) => pBoundaryAt(s, lt, gtFrom), '\n');
  s = replaceTags(s, (lt, gtFrom) => blockTagAt(s, lt, gtFrom), '\n');
  s = replaceTags(s, (lt, gtFrom) => anyTagAt(lt, gtFrom), '');
  const decoded = s
    .replace(/&#(\d+);/g, (m, dec: string) => decodeCodePoint(Number(dec), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => decodeCodePoint(parseInt(hex, 16), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m)
    // &amp; последним — двойное кодирование (&amp;lt;) не превращается в «<».
    .replace(/&amp;/gi, '&');
  return decoded
    .split('\n')
    .map(trimLineEnd)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ─────────────── Курсор страниц ─────────────── */

/**
 * Курсор «старее этого ответа»: время и id последней строки страницы. Ключ
 * (occurred_at, id) уникален, поэтому страницы не теряют и не повторяют
 * строки даже при одинаковом времени.
 */
export interface HeEngRepliesCursor {
  /** ISO-время (UTC, мс — так его пишет приёмник вебхука). */
  at: string;
  id: number;
}

/**
 * Курсор из query (`before_at`, `before_id`). Нет обоих — первая страница
 * (null); есть один, или значение кривое — 'invalid'.
 */
export function parseHeEngRepliesCursor(
  beforeAt: string | null,
  beforeId: string | null,
): HeEngRepliesCursor | null | 'invalid' {
  const at = beforeAt?.trim() ?? '';
  const id = beforeId?.trim() ?? '';
  if (!at && !id) return null;
  if (!at || !/^\d{1,15}$/.test(id)) return 'invalid';
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return 'invalid';
  return { at: new Date(ms).toISOString(), id: Number(id) };
}

/* ─────────────── Ответы ─────────────── */

/** Ответ на кампанию клиента — ровно то, что видит кабинет. */
export interface HeEngReplyItem {
  /** id события в нашей таблице (для ключей списка и курсора). */
  id: string;
  /** Адрес контакта кампании, к которому рассыльщик привязал ответ. */
  contact_email: string;
  subject: string | null;
  /** Простой текст ответа; null — текста в уведомлении не было. */
  text: string | null;
  /** Показано только начало ответа: обрезано по потолку или есть только отрывок. */
  text_partial: boolean;
  /** Когда пришёл ответ (ISO). */
  replied_at: string;
  campaign_name: string;
  vertical_name: string;
}

interface ActivityReplyRow {
  id: number | string;
  campaign_id: string | null;
  lead_email: string | null;
  occurred_at: string;
  reply_subject?: string | null;
  reply_text?: string | null;
  reply_snippet?: string | null;
  email_id?: string | null;
  /** Ящик-получатель: `email_account` события рассыльщика. */
  mailbox?: string | null;
  /** Он же под именем письма LIST /emails (`eaccount`) — запасное. */
  mailbox_eaccount?: string | null;
}

// Одной строкой-литералом: из склейки клиент Supabase не выводит тип строк.
// HTML ответа здесь не читается — только для строк без текста, вторым запросом.
const REPLY_COLUMNS =
  'id, campaign_id, lead_email, occurred_at, reply_subject:raw->>reply_subject, reply_text:raw->>reply_text, reply_snippet:raw->>reply_text_snippet, email_id:raw->>email_id, mailbox:raw->>email_account, mailbox_eaccount:raw->>eaccount';

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function rowTime(row: ActivityReplyRow): number {
  const t = Date.parse(row.occurred_at);
  return Number.isFinite(t) ? t : 0;
}

function rowId(row: ActivityReplyRow): number {
  const n = Number(row.id);
  return Number.isFinite(n) ? n : 0;
}

/** Порядок ленты: свежие сверху, при равном времени — больший id выше. */
function newerFirst(a: ActivityReplyRow, b: ActivityReplyRow): number {
  return rowTime(b) - rowTime(a) || rowId(b) - rowId(a);
}

function cursorOf(row: ActivityReplyRow): HeEngRepliesCursor {
  return { at: new Date(rowTime(row)).toISOString(), id: rowId(row) };
}

/** Ящик-получатель события (lowercase) или null — неизвестен. */
function receivingMailbox(row: ActivityReplyRow): string | null {
  return normalizeMailbox(row.mailbox) ?? normalizeMailbox(row.mailbox_eaccount);
}

/**
 * Строка события → элемент кабинета. `html` — reply_html этой строки, если его
 * дочитывали (у строки нет reply_text). Чистая функция.
 */
function heEngReplyItemFromRow(
  row: ActivityReplyRow,
  campaign: HeEngReplyCampaign,
  html: string | null = null,
): HeEngReplyItem {
  const htmlText = html ? heEngReplyHtmlToText(html) : null;
  const fromText = nonEmpty(row.reply_text);
  const full = fromText ?? nonEmpty(htmlText);
  const htmlCut = !fromText && full !== null && (html?.length ?? 0) > MAX_HTML_SCAN_CHARS;
  const snippet = full ? null : nonEmpty(row.reply_snippet);
  const body = full ?? snippet;
  const text = body ? body.slice(0, MAX_TEXT_CHARS) : null;
  const subject = nonEmpty(row.reply_subject);
  return {
    id: String(row.id),
    contact_email: row.lead_email ?? '',
    subject: subject ? subject.slice(0, MAX_SUBJECT_CHARS) : null,
    text,
    text_partial: Boolean(snippet) || htmlCut || (body !== null && body.length > MAX_TEXT_CHARS),
    replied_at: new Date(rowTime(row)).toISOString(),
    campaign_name: campaign.campaignName,
    vertical_name: campaign.verticalName,
  };
}

/** Ответ, скрытый как полученный чужим ящиком, — для лога роута. */
export interface HeEngHiddenReply {
  id: string;
  mailbox: string;
}

export type HeEngRepliesRead =
  | { ok: true; items: HeEngReplyItem[]; next: HeEngRepliesCursor | null; hidden: HeEngHiddenReply[] }
  | { ok: false; error: unknown };

/**
 * Страница ответов на кампании `campaigns`, старее курсора `before` (null —
 * с самого свежего). `next` — курсор следующей страницы; null — старее нет.
 *
 * `mailboxes` — ящики клиента (readHeEngReplyMailboxes): ответ, пришедший на
 * известный ящик не из набора, не показывается (`hidden`); правило — шапка,
 * «ЧУЖОЙ ЯЩИК». Скрытые и повторы доставки не занимают места на странице:
 * страница дочитывает следующие окна, пока не наберёт `limit`, не больше
 * FILL_ROUNDS окон; курсор — по последней ПРОЧИТАННОЙ строке, так что скрытые
 * не читаются второй раз.
 */
export async function readHeEngReplies(
  db: SupabaseClient,
  campaigns: ReadonlyArray<HeEngReplyCampaign>,
  options: { limit: number; before: HeEngRepliesCursor | null; mailboxes: ReadonlySet<string> | null },
): Promise<HeEngRepliesRead> {
  const limit = Math.max(1, Math.min(HE_ENG_REPLIES_MAX_PAGE_SIZE, Math.trunc(options.limit) || HE_ENG_REPLIES_PAGE_SIZE));
  const byId = new Map(campaigns.map((c) => [c.campaignId, c]));
  const ids = [...byId.keys()];
  if (ids.length === 0) return { ok: true, items: [], next: null, hidden: [] };

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CAMPAIGN_CHUNK) chunks.push(ids.slice(i, i + CAMPAIGN_CHUNK));

  /** Окно: `size` самых свежих строк старее `before` и признак «есть старее». */
  const readWindow = async (
    before: HeEngRepliesCursor | null,
    size: number,
  ): Promise<{ ok: true; rows: ActivityReplyRow[]; hasMore: boolean } | { ok: false; error: unknown }> => {
    const results = await Promise.all(
      chunks.map((chunk) => {
        let query = db
          .from(HE_ENG_ACTIVITY_TABLE)
          .select(REPLY_COLUMNS)
          .eq('event_type', 'replied')
          .in('campaign_id', chunk);
        if (before) {
          query = query.or(`occurred_at.lt.${before.at},and(occurred_at.eq.${before.at},id.lt.${before.id})`);
        }
        // size + 1 — признак «есть старее» без count(*) по таблице.
        return query.order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(size + 1);
      }),
    );
    const rows: ActivityReplyRow[] = [];
    for (const res of results) {
      if (res.error) return { ok: false, error: res.error };
      rows.push(...((res.data ?? []) as unknown as ActivityReplyRow[]));
    }
    rows.sort(newerFirst);
    return { ok: true, rows: rows.slice(0, size), hasMore: rows.length > size };
  };

  const kept: ActivityReplyRow[] = [];
  const hidden: HeEngHiddenReply[] = [];
  // Повтор доставки с другим ключом дедупа (тот же email_id) — одна строка.
  const seenEmail = new Set<string>();
  let before = options.before;
  let last: ActivityReplyRow | null = null;
  let hasMore = true;
  for (let round = 0; round < FILL_ROUNDS && hasMore && kept.length < limit; round += 1) {
    const window = await readWindow(before, limit - kept.length);
    if (!window.ok) return { ok: false, error: window.error };
    hasMore = window.hasMore;
    const fresh = window.rows.filter((row) => {
      const emailId = nonEmpty(row.email_id);
      if (!emailId) return true;
      if (seenEmail.has(emailId)) return false;
      seenEmail.add(emailId);
      return true;
    });
    // Правило RU-фильтра как есть (шапка, «ЧУЖОЙ ЯЩИК»).
    const split = partitionForeignEmails(
      fresh.map((row) => ({ row, eaccount: receivingMailbox(row) })),
      options.mailboxes,
    );
    for (const v of split.visible) kept.push(v.row);
    for (const h of split.hidden) hidden.push({ id: String(h.row.id), mailbox: h.eaccount ?? '' });
    if (window.rows.length > 0) {
      last = window.rows[window.rows.length - 1];
      before = cursorOf(last);
    }
  }

  // reply_html — только строкам без reply_text и только этой страницы.
  const htmlById = new Map<string, string>();
  const needHtml = kept.filter((row) => !nonEmpty(row.reply_text)).map((row) => row.id);
  if (needHtml.length > 0) {
    const { data, error } = await db
      .from(HE_ENG_ACTIVITY_TABLE)
      .select('id, reply_html:raw->>reply_html')
      .in('id', needHtml);
    if (error) return { ok: false, error };
    for (const r of (data ?? []) as unknown as Array<{ id: number | string; reply_html: string | null }>) {
      const html = nonEmpty(r.reply_html);
      if (html) htmlById.set(String(r.id), html);
    }
  }

  const items: HeEngReplyItem[] = [];
  for (const row of kept) {
    const campaign = byId.get(row.campaign_id ?? '');
    // Строка пришла по in(campaign_id) — кампания всегда известна; проверка
    // держит правило «только его кампании» и без опоры на фильтр запроса.
    if (!campaign) continue;
    items.push(heEngReplyItemFromRow(row, campaign, htmlById.get(String(row.id)) ?? null));
  }
  return {
    ok: true,
    items,
    next: hasMore && last ? cursorOf(last) : null,
    hidden,
  };
}
