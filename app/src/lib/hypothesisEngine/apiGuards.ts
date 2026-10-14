/**
 * Скоуп-проверки владельца для клиентского ENG-контуру «Движка вертикалей»
 * (api/client/eng/*): клиент видит и меняет только проекты, где
 * he_projects.created_by = его user id. Чужие идентификаторы отвечают 404
 * (существование объекта не раскрываем), инфраструктурные ошибки — 500.
 *
 * Каждый лоадер грузит целевую строку + её проект и сверяет владельца.
 * Сообщения EN — это клиентский контур с английским UI.
 *
 * Здесь же `requireEngMarket` — гейт «этот кабинет вообще для этого клиента»:
 * скоуп владельца отвечает на вопрос «чья строка», рынок — «чей раздел».
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logError, logWarn } from '@/lib/loggerServer';
import type { ClientMarket } from '@/lib/engMarket';
import { readHeEngAccountBlock } from './engAccountBlockMarker';

// Гейт платных шагов (почта, лимиты, расход клиента) — рядом с рыночным:
// роуты контура берут оба отсюда. Реализация и таблица «действие → проверки»
// — engPaidAccess.ts.
export {
  requireEngPaidAccess,
  engPaidAccessResponse,
  type EngPaidAction,
  type EngPaidAccessCode,
  type EngPaidAccessRefusal,
  type EngPaidAccessResult,
} from './engPaidAccess';

export interface HeScopeFailure {
  status: number;
  message: string;
}

export type HeScopeResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; failure: HeScopeFailure };

type Row = Record<string, unknown>;

function notFound(message: string): HeScopeFailure {
  return { status: 404, message };
}

/**
 * Текст сбоя БД клиенту НЕ отдаём: в сообщении Postgres едут имена таблиц
 * `he_*`, типы колонок и текст запроса (для кривого uuid это 22P02
 * «invalid input syntax for type uuid: …»). Наружу — константа, подробности в
 * application_logs.
 */
const DB_ERROR_MESSAGE = 'Database error';

function dbError(): HeScopeFailure {
  return { status: 500, message: DB_ERROR_MESSAGE };
}

/** PGRST116 («строк нет») — легитимное отсутствие; прочие ошибки — сбой БД. */
function failureFrom(error: { message: string; code?: string } | null, notFoundMessage: string): HeScopeFailure {
  if (error?.code === 'PGRST116') return notFound(notFoundMessage);
  // Логируем fire-and-forget: writeLog сам глотает свои ошибки (loggerServer
  // держит backoff), а гейт стоит на пути клиентского запроса — ждать запись
  // лога незачем.
  void logError('client.eng.scope.db_error', error, { scope: notFoundMessage });
  return dbError();
}

/**
 * Отказ рыночного гейта — единственное место контура, где клиент получает 403
 * «раздел не для вашего аккаунта», и до этой правки он был НЕМЫМ: наружу
 * английская константа без причины, в логах — ничего. Оператор, которому
 * клиент пишет «кабинет не грузится», не мог отличить «у профиля market='ru'»
 * от «лёг воркер». Пишем `warn`, а не `error`: это штатный отказ доступа.
 *
 * Дроссель — не украшение. Денай стоит на КАЖДОМ запросе контура (загрузка
 * дашборда — это несколько запросов), а клиент с чужим рынком обычно ломится
 * повтором, и без окна одна вкладка дописывала бы в `application_logs` строку
 * на запрос. Причина отказа от повтора не меняется, поэтому одной записи на
 * пользователя в окно достаточно. Окно — процессное; несколько инстансов дадут
 * несколько записей, и это нормально: цель — чтобы отказ было ВИДНО, а не
 * посчитать его точно.
 */
const MARKET_DENIAL_LOG_WINDOW_MS = 10 * 60 * 1000;
/** userId → момент последней записи. Кэш дросселя, живёт в памяти процесса. */
const marketDenialLoggedAt = new Map<string, number>();
/** Потолок карты: поток разных userId не должен растить её без предела. */
const MARKET_DENIAL_LOG_MAX_KEYS = 500;

function noteMarketDenial(userId: string, role: string | null, profileFound: boolean): void {
  const now = Date.now();
  if (now - (marketDenialLoggedAt.get(userId) ?? 0) < MARKET_DENIAL_LOG_WINDOW_MS) return;
  // Переполнение чистим целиком: это кэш, и потеря записи стоит ровно одной
  // лишней строки лога — дешевле, чем LRU ради дросселя.
  if (marketDenialLoggedAt.size >= MARKET_DENIAL_LOG_MAX_KEYS) marketDenialLoggedAt.clear();
  marketDenialLoggedAt.set(userId, now);
  // profileFound различает две разные причины с одним ответом: «профиль есть,
  // но рынок ru» (клиента завели не через ENG-хост) и «профиля/колонки нет».
  void logWarn(
    'client.eng.market_gate.denied',
    'ENG cabinet API denied: profile market is not eng',
    { role, profileFound },
    { userId },
  );
}

/**
 * Рыночный гейт клиентского ENG-контура: RU-клиенту в `/api/client/eng/**`
 * делать нечего.
 *
 * Зачем guard, а не middleware: рыночные гейты middleware работают только по
 * СТРАНИЦАМ (`pathname.startsWith('/client')`, middleware.ts), а `/api/client/eng/*`
 * начинается с `/api` и под них не попадает — любой залогиненный ru-клиент
 * своим токеном создавал `market='us'` проекты и крутил платный LLM-пайплайн.
 *
 * Три решения, важные для живого кабинета:
 *  - ставится в роуте ПОСЛЕ ветки `serveClientDemo` — демо ходит фикстурами,
 *    рынка у него нет, и гейт бы его закрыл;
 *  - не-клиентские роли (admin) пропускаем: `market` у сотрудников не
 *    проставлен, а ENG-контур им нужен для отладки (requireClientAuth уже
 *    отсёк всех, кроме client/admin);
 *  - рынок неизвестен (профиля нет; колонки `market` ещё нет — она из
 *    миграции 20260804_0004) → `'ru'`, ровно как фолбэк middleware: гейт в
 *    непонятной ситуации закрывается, а не открывается. Отдельно от этого
 *    инфраструктурный сбой чтения профиля отдаёт 503 «обновите страницу» —
 *    тот же контракт, что у requireClientAuth, чтобы блип main-БД не выглядел
 *    как «вам сюда нельзя».
 *
 * Почему ВТОРОЕ чтение profiles, хотя requireClientAuth (lib/clientApiHelper.ts)
 * ту же строку уже прочитал под роль: дешевле было бы дочитать там `market` и
 * вернуть его наружу, но этот хелпер обслуживает ВЕСЬ клиентский кабинет, в том
 * числе RU, и любую ошибку чтения профиля кроме PGRST116 превращает в 503. Стоит
 * колонке `market` отсутствовать (окружение без 20260804_0004) или быть
 * переименованной — PostgREST вернёт 42703 на весь select, и вместо закрытого
 * ENG-раздела ляжет весь /api/client/*. Здесь же 42703 штатно означает «рынок
 * неизвестен». Цена разделения — один индексный select по PK на ENG-запрос;
 * платим её сознательно. Объединять только вместе с правкой контракта
 * requireClientAuth (отдавать роль и рынок одной строкой, 42703 глотать) — это
 * отдельная задача с RU-регрессом, а не попутная микрооптимизация.
 *
 * ПОЧЕМУ ЭТО НЕ ЗАПИРАЕТ ЖИВЫХ КЛИЕНТОВ (проверено по коду, не предположение).
 * Страничный гейт middleware работает уже сегодня и решает РОВНО тем же
 * предикатом, что и строка `market` ниже: `middleware.ts`, ветка «(б) ru-клиент
 * в ENG-разделе» — `profileMarket === 'eng' ? 'eng' : 'ru'`, и всё, что не
 * 'eng', уводится с `/client/eng*` на `/client`; ветка «(в)» тем же предикатом
 * выкидывает такого клиента с ENG-хоста на основной. Значит клиент с
 * `market <> 'eng'` не может открыть НИ ОДНУ страницу кабинета уже сейчас — и
 * API, который эти страницы дёргают, ему нечем вызывать. Гейт здесь закрывает
 * не страницы, а обход страниц (fetch по токену мимо UI), и множество
 * допущенных у обоих гейтов одинаково. Предикат совпадает с middleware буква в
 * букву намеренно: разойдутся предикаты — разойдутся и вердикты.
 *
 * Кэш рынка из третьего сегмента ROLE_COOKIE (middleware, 30 минут) здесь
 * СОЗНАТЕЛЬНО не читаем: доступ решаем по источнику истины, а не по кэшу,
 * живущему у клиента. Единственное возможное расхождение — рынок сняли с 'eng'
 * на 'ru', и до протухания куки страницы ещё открываются, а API уже нет;
 * авторитетен здесь API.
 *
 * Проверка ПЕРЕД деплоем (read-only, руками; БД эта волна не трогает):
 *   select p.id from profiles p
 *    where p.role = 'client' and p.market is distinct from 'eng'
 *      and exists (select 1 from he_projects h where h.created_by = p.id);
 * Пусто — ни один клиент с историей в ENG-кабинете доступа не теряет. Не пусто
 * — это ровно те, кого сегодня уже разворачивает middleware: рынок им
 * проставляют ДО деплоя, а не после жалобы.
 */
export async function requireEngMarket(
  supabase: SupabaseClient,
  userId: string,
): Promise<HeScopeResult<{ market: ClientMarket }>> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role, market')
    .eq('id', userId)
    .single();
  // PGRST116 — профиля нет; 42703 — колонки market ещё нет. Оба случая
  // «рынок неизвестен», прочие коды — сбой инфраструктуры.
  if (error && error.code !== 'PGRST116' && error.code !== '42703') {
    void logError('client.eng.market_gate.profile_failed', error, { userId });
    return {
      ok: false,
      failure: { status: 503, message: 'Service temporarily unavailable — refresh the page' },
    };
  }

  const row = (profile ?? null) as Row | null;
  const role = typeof row?.role === 'string' ? row.role : null;
  const market: ClientMarket = row?.market === 'eng' ? 'eng' : 'ru';

  if (role !== null && role !== 'client') return { ok: true, market };
  if (market !== 'eng') {
    noteMarketDenial(userId, role, row !== null);
    return { ok: false, failure: { status: 403, message: 'This section is not available for your account' } };
  }
  // Заблокированный ENG-клиент (аудит 14.10.2026): отметку блокировки читал
  // только гейт платных шагов, а неплатные мутации (письма, рынки, расписание
  // кампаний у рассыльщика) шли до 6 часов — пока жив JWT, если отзыв сессий
  // при блокировке не лёг. Этот гейт закрывает только роуты, которые его
  // зовут (/api/client/eng/**, подтверждение почты). Do-not-contact
  // (/api/client/blocklist/**, ветка ENG в _eng.ts) его НЕ зовёт: добавлять и
  // удалять записи заблокированный по одной отметке клиент пока может —
  // открытый пункт аудита, тот файл правится в другой ветке. Одно чтение по ключу на
  // запрос клиента. Бан GoTrue здесь не читаем — это был бы вызов GoTrue на
  // каждый запрос; блокировка из карточки пишет отметку ПЕРВОЙ
  // (engAccountBlock), а бан мимо карточки держат вход и платный гейт
  // (readHeEngOwnerHold, standing). Таблицы нет (миграция 20261013_0001) — как
  // у остальных читателей отметки, не мешает; сбой чтения — 503, как у
  // профиля выше: «не прочитали» не превращается ни в «можно», ни в «нельзя».
  const block = await readHeEngAccountBlock(supabase, userId);
  if (block.state === 'blocked') {
    return { ok: false, failure: { status: 403, message: ENG_ACCOUNT_BLOCKED_TEXT } };
  }
  if (block.state === 'error') {
    void logError('client.eng.market_gate.block_read_failed', null, { userId, detail: block.detail.slice(0, 300) });
    return {
      ok: false,
      failure: { status: 503, message: 'Service temporarily unavailable — refresh the page' },
    };
  }
  return { ok: true, market };
}

/**
 * Отказ рыночного гейта заблокированному клиенту — то же слово, что у входа
 * (LoginForm, ENG-хост). Не обещает ни сроков, ни контакта: куда писать,
 * решает владелец (аудит 14.10.2026).
 */
export const ENG_ACCOUNT_BLOCKED_TEXT = 'This account is blocked.';

/** Проект, принадлежащий клиенту (created_by = userId). */
export async function loadClientHeProject(
  supabase: SupabaseClient,
  projectId: string,
  userId: string,
): Promise<HeScopeResult<{ project: Row }>> {
  const { data: project, error } = await supabase
    .from('he_projects')
    .select('*')
    .eq('id', projectId)
    .eq('created_by', userId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Project not found') };
  return { ok: true, project: project as Row };
}

/**
 * Проект-владелец для дочерней сущности. foundProject=false означает «проекта
 * нет или он чужой» — наружу всегда 404, различать не нужно.
 */
async function loadOwnedProject(
  supabase: SupabaseClient,
  projectId: string,
  userId: string,
  notFoundMessage: string,
): Promise<{ project: Row } | { failure: HeScopeFailure }> {
  const { data: project, error } = await supabase
    .from('he_projects')
    .select('id, created_by, market, status')
    .eq('id', projectId)
    .single();
  if (error) return { failure: failureFrom(error, notFoundMessage) };
  if ((project as Row).created_by !== userId) return { failure: notFound(notFoundMessage) };
  return { project: project as Row };
}

export async function loadClientHeVertical(
  supabase: SupabaseClient,
  verticalId: string,
  userId: string,
): Promise<HeScopeResult<{ vertical: Row; project: Row }>> {
  const { data: vertical, error } = await supabase
    .from('he_verticals')
    .select('id, project_id, name')
    .eq('id', verticalId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Vertical not found') };
  const owned = await loadOwnedProject(supabase, (vertical as Row).project_id as string, userId, 'Vertical not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, vertical: vertical as Row, project: owned.project };
}

export async function loadClientHeHypothesis(
  supabase: SupabaseClient,
  hypothesisId: string,
  userId: string,
): Promise<HeScopeResult<{ hypothesis: Row; project: Row }>> {
  const { data: hypothesis, error } = await supabase
    .from('he_hypotheses')
    .select('id, project_id')
    .eq('id', hypothesisId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Hypothesis not found') };
  const owned = await loadOwnedProject(supabase, (hypothesis as Row).project_id as string, userId, 'Hypothesis not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, hypothesis: hypothesis as Row, project: owned.project };
}

export async function loadClientHeBase(
  supabase: SupabaseClient,
  baseId: string,
  userId: string,
): Promise<HeScopeResult<{ base: Row; project: Row }>> {
  const { data: base, error } = await supabase
    .from('he_bases')
    .select('id, project_id, status')
    .eq('id', baseId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Base not found') };
  const owned = await loadOwnedProject(supabase, (base as Row).project_id as string, userId, 'Base not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, base: base as Row, project: owned.project };
}

/** Цепочка → вертикаль → проект (у he_chains нет project_id). */
export async function loadClientHeChain(
  supabase: SupabaseClient,
  chainId: string,
  userId: string,
): Promise<HeScopeResult<{ chain: Row; vertical: Row; project: Row }>> {
  const { data: chain, error } = await supabase
    .from('he_chains')
    .select('id, vertical_id')
    .eq('id', chainId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Chain not found') };
  const { data: vertical, error: vertErr } = await supabase
    .from('he_verticals')
    .select('id, project_id')
    .eq('id', (chain as Row).vertical_id as string)
    .single();
  if (vertErr) return { ok: false, failure: failureFrom(vertErr, 'Chain not found') };
  const owned = await loadOwnedProject(supabase, (vertical as Row).project_id as string, userId, 'Chain not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, chain: chain as Row, vertical: vertical as Row, project: owned.project };
}

/** Шаблон → вертикаль → проект (у he_templates нет project_id). */
export async function loadClientHeTemplate(
  supabase: SupabaseClient,
  templateId: string,
  userId: string,
): Promise<HeScopeResult<{ template: Row; project: Row }>> {
  const { data: template, error } = await supabase
    .from('he_templates')
    .select('id, vertical_id')
    .eq('id', templateId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Template not found') };
  const { data: vertical, error: vertErr } = await supabase
    .from('he_verticals')
    .select('id, project_id')
    .eq('id', (template as Row).vertical_id as string)
    .single();
  if (vertErr) return { ok: false, failure: failureFrom(vertErr, 'Template not found') };
  const owned = await loadOwnedProject(supabase, (vertical as Row).project_id as string, userId, 'Template not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, template: template as Row, project: owned.project };
}
