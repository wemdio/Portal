/**
 * Подтверждение почты клиентов ENG-кабинета (app.outreachos.xyz).
 *
 * ПОЧЕМУ НЕ ЧЕРЕЗ SUPABASE. Регистрация (api/signup) создаёт пользователя с
 * email_confirm: true — вход работает сразу, и так остаётся: RU-регистрация,
 * вход и сброс пароля общие, их не трогаем. Подтверждение ENG живёт рядом, в
 * таблице he_eng_email_verifications (миграция 20261010_0001), и закрывает
 * только платные шаги ENG-кабинета (engPaidAccess.requireEngPaidAccess).
 *
 * ССЫЛКА. `v1.<userId>.<exp>.<nonce>.<sig>`:
 *  - nonce — 32 случайных байта; в строке таблицы лежит только его SHA-256
 *    (token_hash). Новая отправка заменяет хэш, поэтому прежняя ссылка
 *    перестаёт работать (состояние 'superseded'). Письмо с новой ссылкой
 *    почтовый сервер не принял — прежний хэш возвращается (см. issue ниже):
 *    сбой отправки не отнимает у клиента ссылку, которая у него уже есть;
 *  - exp — срок, секунды Unix (HE_ENG_EMAIL_TOKEN_TTL_MS от отправки);
 *  - sig — HMAC-SHA256 ключом engServerKey('email-verify') по всей строке до
 *    подписи: срок и пользователя нельзя подменить, мусор отсекается без БД.
 * Одноразовость держит условное обновление (consume ниже): подтверждает
 * только запись, у которой хэш ещё совпадает и verified_at пуст; оно же
 * стирает хэш.
 *
 * СТРОКА ТАБЛИЦЫ. Нет строки — почта не подтверждена (новый аккаунт, который
 * ещё не получил письмо, или аккаунт, созданный между накатом миграции и
 * выкатом кода). Строка с verified_at — подтверждена, но только для адреса в
 * `email`: сменился адрес входа — нужно подтвердить новый. Существующие ENG-
 * аккаунты с проектами миграция пометила подтверждёнными (см. её шапку).
 *
 * АДРЕС — адрес входа из auth.users (readHeEngAuthEmail), не profiles.email:
 * тот клиент переписывает сам, и он не уникален (аудит 14.10.2026).
 *
 * ТАБЛИЦЫ НЕТ (миграция не применена): чтение отвечает 'table_missing', и
 * гейт платных шагов пропускает как до этой правки (engPaidAccess);
 * отправка письма отвечает 'unavailable'.
 *
 * Модуль без логгера и без `server-only` (отправку письма передаёт
 * вызывающий: engEmailVerificationMail.ts).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveHeEngKey } from './engServerKey';

export const HE_ENG_EMAIL_VERIFICATIONS_TABLE = 'he_eng_email_verifications';
/** Срок ссылки: 48 часов от отправки. */
export const HE_ENG_EMAIL_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

const TOKEN_VERSION = 'v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Нет таблицы: 42P01 от Postgres, PGRST205 от PostgREST (нет в кэше схемы). */
export function isHeMissingTableError(error: { code?: unknown } | null | undefined): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}

export function normalizeHeEngEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email ? email : null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/* ─────────────── Ссылка ─────────────── */

export interface HeEngEmailToken {
  token: string;
  /** SHA-256 nonce — то, что ложится в token_hash. */
  nonceHash: string;
  expiresAt: Date;
}

/** null — нет ключа (SUPABASE_SERVICE_ROLE_KEY не задан): подписать нечем. */
export function createHeEngEmailToken(
  userId: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): HeEngEmailToken | null {
  const key = deriveHeEngKey('email-verify', env);
  if (!key || !UUID_RE.test(userId)) return null;
  const nonce = randomBytes(32).toString('base64url');
  const exp = Math.floor((nowMs + HE_ENG_EMAIL_TOKEN_TTL_MS) / 1000);
  const body = `${TOKEN_VERSION}.${userId.toLowerCase()}.${exp}.${nonce}`;
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return { token: `${body}.${sig}`, nonceHash: sha256Hex(nonce), expiresAt: new Date(exp * 1000) };
}

export type HeEngTokenParse =
  | { ok: true; userId: string; nonceHash: string; expired: boolean }
  | { ok: false; reason: 'invalid' | 'no_key' };

/**
 * Разобрать и проверить подпись. Срок НЕ отказ здесь, а флаг: уже
 * подтверждённому аккаунту просроченная ссылка отвечает «уже подтверждено», а
 * не «ссылка истекла» — решает consume.
 */
export function parseHeEngEmailToken(
  raw: unknown,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): HeEngTokenParse {
  const key = deriveHeEngKey('email-verify', env);
  if (!key) return { ok: false, reason: 'no_key' };
  if (typeof raw !== 'string' || raw.length > 400) return { ok: false, reason: 'invalid' };
  const parts = raw.trim().split('.');
  if (parts.length !== 5) return { ok: false, reason: 'invalid' };
  const [version, userId, expRaw, nonce, sig] = parts;
  if (version !== TOKEN_VERSION || !UUID_RE.test(userId) || !/^\d{1,12}$/.test(expRaw)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!B64URL_RE.test(nonce) || !B64URL_RE.test(sig)) return { ok: false, reason: 'invalid' };
  const expected = createHmac('sha256', key)
    .update(`${version}.${userId}.${expRaw}.${nonce}`)
    .digest('base64url');
  if (!sameText(expected, sig)) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    userId: userId.toLowerCase(),
    nonceHash: sha256Hex(nonce),
    expired: Number(expRaw) * 1000 <= nowMs,
  };
}

/* ─────────────── Состояние ─────────────── */

export interface HeEngEmailVerificationRow {
  email: string;
  verified_at: string | null;
  token_hash: string | null;
  last_sent_at: string | null;
}

export type HeEngEmailRowRead =
  | { kind: 'row'; row: HeEngEmailVerificationRow }
  | { kind: 'none' }
  | { kind: 'table_missing' }
  | { kind: 'error'; message: string };

export async function readHeEngEmailVerification(db: SupabaseClient, userId: string): Promise<HeEngEmailRowRead> {
  const { data, error } = await db
    .from(HE_ENG_EMAIL_VERIFICATIONS_TABLE)
    .select('email, verified_at, token_hash, last_sent_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (isHeMissingTableError(error)) return { kind: 'table_missing' };
    return { kind: 'error', message: `${HE_ENG_EMAIL_VERIFICATIONS_TABLE} read: ${error.code ?? 'error'}` };
  }
  if (!data) return { kind: 'none' };
  const row = data as Record<string, unknown>;
  return {
    kind: 'row',
    row: {
      email: typeof row.email === 'string' ? row.email : '',
      verified_at: typeof row.verified_at === 'string' ? row.verified_at : null,
      token_hash: typeof row.token_hash === 'string' ? row.token_hash : null,
      last_sent_at: typeof row.last_sent_at === 'string' ? row.last_sent_at : null,
    },
  };
}

/**
 * Подтверждена ли почта ЭТОГО адреса. Адрес входа неизвестен (null) —
 * решает одна отметка verified_at.
 */
export function isHeEngEmailVerified(row: HeEngEmailVerificationRow, currentEmail: string | null): boolean {
  if (!row.verified_at) return false;
  return currentEmail === null || normalizeHeEngEmail(row.email) === currentEmail;
}

/**
 * Жива ли ссылка, ушедшая в момент `sentAt` (last_sent_at строки):
 *  - 'none'    — не уходила (или отметка нечитаема: ни «откройте», ни дату
 *                сказать нельзя);
 *  - 'live'    — срок ещё не вышел;
 *  - 'expired' — срок вышел: consume ответит на неё 'expired'.
 * Срок считается ровно как у самой ссылки: exp в ней — целые секунды от
 * момента отправки (createHeEngEmailToken), а last_sent_at пишется тем же
 * моментом (issue ниже), поэтому граница здесь и у consume одна.
 */
export function heEngEmailLinkState(sentAt: string | null, nowMs: number): 'none' | 'live' | 'expired' {
  if (!sentAt) return 'none';
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return 'none';
  const expiresMs = Math.floor((sentMs + HE_ENG_EMAIL_TOKEN_TTL_MS) / 1000) * 1000;
  return expiresMs <= nowMs ? 'expired' : 'live';
}

/**
 * Состояние для кабинета и гейта:
 *  - 'not_required' — проверка не к этому аккаунту: не клиент (сотрудник в
 *    ENG-кабинете) — так же, как рыночный гейт пропускает не-клиентов;
 *  - 'verified'     — подтверждена для текущего адреса входа (auth.users);
 *  - 'pending'      — не подтверждена. Про ссылку на ТЕКУЩИЙ адрес (ссылка
 *                     на другой адрес — как не уходившая):
 *                       `lastSentAt` — когда ушла ссылка, которая ЕЩЁ
 *                       действует (null — такой нет); только по нему можно
 *                       сказать «мы отправили — откройте»;
 *                       `expiredLinkSentAt` — когда ушла ссылка, срок
 *                       которой вышел (null — такой нет): «ссылка от …
 *                       истекла — отправьте новую». Задано не больше одного;
 *  - 'table_missing'— миграция 20261010_0001 не применена;
 *  - 'error'        — сбой чтения (профиль, пользователь GoTrue или таблица).
 */
export type HeEngEmailStatus =
  | { state: 'not_required'; email: string | null }
  | { state: 'verified'; email: string | null }
  | { state: 'pending'; email: string | null; lastSentAt: string | null; expiredLinkSentAt: string | null }
  | { state: 'table_missing'; email: string | null }
  | { state: 'error'; message: string };

/**
 * Адрес входа аккаунта — из auth.users (GoTrue admin API), а НЕ из
 * profiles.email (аудит 14.10.2026): profiles.email клиент переписывает сам
 * (column grant update(email) у authenticated, 20260730_0001), и он не
 * уникален. Подтверждение, письма ENG-клиенту и сброс пароля должны говорить
 * про адрес, которым клиент входит. 'missing' — пользователя нет.
 */
export type HeEngAuthEmailRead =
  | { kind: 'ok'; email: string | null }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export async function readHeEngAuthEmail(db: SupabaseClient, userId: string): Promise<HeEngAuthEmailRead> {
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) {
      const e = error as { status?: unknown; code?: unknown; message?: unknown };
      if (e.status === 404 || e.code === 'user_not_found') return { kind: 'missing' };
      return { kind: 'error', message: `auth user read: ${String(e.message ?? 'error').slice(0, 120)}` };
    }
    if (!data?.user) return { kind: 'missing' };
    return { kind: 'ok', email: normalizeHeEngEmail(data.user.email) };
  } catch (e) {
    return { kind: 'error', message: `auth user read threw: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}` };
  }
}

export async function readHeEngEmailStatus(
  db: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<HeEngEmailStatus> {
  const [{ data: profile, error: profileErr }, auth] = await Promise.all([
    db.from('profiles').select('role').eq('id', userId).maybeSingle(),
    readHeEngAuthEmail(db, userId),
  ]);
  if (profileErr) return { state: 'error', message: `profiles read: ${profileErr.code ?? 'error'}` };
  if (auth.kind === 'error') return { state: 'error', message: auth.message };
  const p = (profile ?? null) as { role?: unknown } | null;
  // Адрес входа (readHeEngAuthEmail). Пользователя нет — адрес неизвестен
  // (null): решает одна отметка verified_at, отправка ссылки ответит
  // 'unavailable'.
  const email = auth.kind === 'ok' ? auth.email : null;
  // Как requireEngMarket: не-клиентские роли (сотрудник отлаживает кабинет)
  // проходят; профиля нет — это клиент без строки, проверяем как клиента.
  if (p && typeof p.role === 'string' && p.role !== 'client') return { state: 'not_required', email };

  const read = await readHeEngEmailVerification(db, userId);
  if (read.kind === 'error') return { state: 'error', message: read.message };
  if (read.kind === 'table_missing') return { state: 'table_missing', email };
  if (read.kind === 'none') return { state: 'pending', email, lastSentAt: null, expiredLinkSentAt: null };
  if (isHeEngEmailVerified(read.row, email)) return { state: 'verified', email };
  const sameAddress = email === null || normalizeHeEngEmail(read.row.email) === email;
  const sentAt = sameAddress ? read.row.last_sent_at : null;
  const link = heEngEmailLinkState(sentAt, nowMs);
  return {
    state: 'pending',
    email,
    lastSentAt: link === 'live' ? sentAt : null,
    expiredLinkSentAt: link === 'expired' ? sentAt : null,
  };
}

/* ─────────────── Отправка ссылки ─────────────── */

export interface HeEngVerificationLetter {
  to: string;
  link: string;
  expiresAt: Date;
}

export type HeEngIssueOutcome =
  | { kind: 'sent'; email: string }
  | { kind: 'already_verified' }
  /** Таблицы нет, ключа нет или адрес неизвестен — ссылку выдать нельзя. */
  | { kind: 'unavailable'; reason: string }
  | { kind: 'send_failed'; reason: string }
  | { kind: 'error'; reason: string };

/**
 * Письмо с новой ссылкой не ушло — вернуть строку, какой она была до выдачи:
 * ссылка, которая уже лежит у клиента, снова работает, и отметка о ней снова
 * правда. Условие — хэш ЭТОЙ невыданной ссылки: если параллельная отправка
 * уже заменила его своим, её строку не трогаем. Строки до выдачи не было —
 * удаляем созданную (тот же «нет строки», что и до нажатия).
 * НЕ БРОСАЕТ: null — вернули (или условию уже ничего не соответствует),
 * строка — почему не вышло; тогда строка остаётся с хэшем неотправленной
 * ссылки и пустой last_sent_at — кабинет предлагает отправить ссылку.
 */
async function restoreHeEngEmailLink(
  db: SupabaseClient,
  userId: string,
  unsentHash: string,
  previous: HeEngEmailVerificationRow | null,
  fallbackEmail: string,
): Promise<string | null> {
  try {
    const { error } = previous
      ? await db
          .from(HE_ENG_EMAIL_VERIFICATIONS_TABLE)
          .update({
            email: previous.email || fallbackEmail,
            verified_at: previous.verified_at,
            token_hash: previous.token_hash,
            last_sent_at: previous.last_sent_at,
          })
          .eq('user_id', userId)
          .eq('token_hash', unsentHash)
      : await db
          .from(HE_ENG_EMAIL_VERIFICATIONS_TABLE)
          .delete()
          .eq('user_id', userId)
          .eq('token_hash', unsentHash);
    return error ? `previous link not restored: ${error.code ?? 'error'}` : null;
  } catch (e) {
    return `previous link not restored: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`;
  }
}

/**
 * Выдать новую ссылку и отправить её. НЕ БРОСАЕТ.
 *
 * Порядок: сначала хэш новой ссылки в строку (иначе письмо ушло бы со
 * ссылкой, которую consume не узнает) и last_sent_at = null, потом письмо,
 * потом last_sent_at — только после того, как письмо принято. Кабинет пишет
 * «мы отправили ссылку на …» по этой отметке, а после замены хэша прежняя
 * ссылка уже не работает ('superseded'): отметка о ней была бы неправдой.
 *
 * Сбой отправки возвращает строку, какой она была до выдачи
 * (restoreHeEngEmailLink): прежняя ссылка снова работает, её отметка снова
 * на месте. Пока письмо отправляется (секунды), прежняя ссылка отвечает
 * 'superseded' — переход по ней в это окно просит отправить новую. Если
 * почтовый сервер на деле принял письмо и только ответ не дошёл, ссылка из
 * этого письма не сработает ('superseded', а без прежней строки — 'invalid'):
 * действует прежняя, если была, иначе — новая отправка.
 */
export async function issueHeEngEmailVerification(
  db: SupabaseClient,
  args: {
    userId: string;
    email: string | null;
    origin: string;
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
    send: (letter: HeEngVerificationLetter) => Promise<void>;
  },
): Promise<HeEngIssueOutcome> {
  const email = normalizeHeEngEmail(args.email);
  if (!email) return { kind: 'unavailable', reason: 'sign-in email unknown' };
  const nowMs = args.nowMs ?? Date.now();
  try {
    const read = await readHeEngEmailVerification(db, args.userId);
    if (read.kind === 'table_missing') return { kind: 'unavailable', reason: 'table missing (migration 20261010_0001 not applied)' };
    if (read.kind === 'error') return { kind: 'error', reason: read.message };
    if (read.kind === 'row' && isHeEngEmailVerified(read.row, email)) return { kind: 'already_verified' };
    const previous = read.kind === 'row' ? read.row : null;

    const token = createHeEngEmailToken(args.userId, nowMs, args.env);
    if (!token) return { kind: 'unavailable', reason: 'signing key unavailable' };

    // verified_at: null — адрес сменился после подтверждения (иначе выше был
    // бы 'already_verified'): подтверждать нужно новый.
    const { error: upsertErr } = await db
      .from(HE_ENG_EMAIL_VERIFICATIONS_TABLE)
      .upsert(
        { user_id: args.userId, email, verified_at: null, token_hash: token.nonceHash, last_sent_at: null },
        { onConflict: 'user_id' },
      );
    if (upsertErr) {
      if (isHeMissingTableError(upsertErr)) return { kind: 'unavailable', reason: 'table missing (migration 20261010_0001 not applied)' };
      return { kind: 'error', reason: `${HE_ENG_EMAIL_VERIFICATIONS_TABLE} upsert: ${upsertErr.code ?? 'error'}` };
    }

    const link = `${args.origin.replace(/\/+$/, '')}/api/client/eng-email/confirm?token=${encodeURIComponent(token.token)}`;
    try {
      await args.send({ to: email, link, expiresAt: token.expiresAt });
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
      const notRestored = await restoreHeEngEmailLink(db, args.userId, token.nonceHash, previous, email);
      return { kind: 'send_failed', reason: notRestored ? `${reason}; ${notRestored}` : reason };
    }

    // Отметка — по хэшу ЭТОЙ ссылки: если параллельная отправка уже заменила
    // хэш, её отметку не трогаем. Сбой записи отметки письма не отменяет.
    await db
      .from(HE_ENG_EMAIL_VERIFICATIONS_TABLE)
      .update({ last_sent_at: new Date(nowMs).toISOString() })
      .eq('user_id', args.userId)
      .eq('token_hash', token.nonceHash);
    return { kind: 'sent', email };
  } catch (e) {
    return { kind: 'error', reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}

/* ─────────────── Переход по ссылке ─────────────── */

/**
 * Итог перехода по ссылке — все состояния:
 *  - 'verified'         — эта ссылка подтвердила почту сейчас;
 *  - 'already_verified' — почта уже подтверждена (повторный клик, сканер
 *                         ссылок почтового сервера успел раньше);
 *  - 'expired'          — подпись верна, срок вышел, почта не подтверждена;
 *  - 'superseded'       — подпись верна, но после неё отправлена новая ссылка;
 *  - 'invalid'          — ссылка обрезана, подделана или строки нет;
 *  - 'unavailable'      — таблицы нет, ключа нет или сбой БД.
 */
export type HeEngConsumeOutcome = 'verified' | 'already_verified' | 'expired' | 'superseded' | 'invalid' | 'unavailable';

export async function consumeHeEngEmailToken(
  db: SupabaseClient,
  rawToken: unknown,
  opts: { nowMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ outcome: HeEngConsumeOutcome; userId: string | null; reason: string | null }> {
  const nowMs = opts.nowMs ?? Date.now();
  const parsed = parseHeEngEmailToken(rawToken, nowMs, opts.env);
  if (!parsed.ok) {
    return parsed.reason === 'no_key'
      ? { outcome: 'unavailable', userId: null, reason: 'signing key unavailable' }
      : { outcome: 'invalid', userId: null, reason: null };
  }
  const { userId, nonceHash } = parsed;
  try {
    const read = await readHeEngEmailVerification(db, userId);
    if (read.kind === 'table_missing') return { outcome: 'unavailable', userId, reason: 'table missing' };
    if (read.kind === 'error') return { outcome: 'unavailable', userId, reason: read.message };
    if (read.kind === 'none') return { outcome: 'invalid', userId, reason: 'no verification row' };
    if (read.row.verified_at) return { outcome: 'already_verified', userId, reason: null };
    if (parsed.expired) return { outcome: 'expired', userId, reason: null };
    if (!read.row.token_hash || !sameText(read.row.token_hash, nonceHash)) {
      return { outcome: 'superseded', userId, reason: null };
    }

    const { data, error } = await db
      .from(HE_ENG_EMAIL_VERIFICATIONS_TABLE)
      .update({ verified_at: new Date(nowMs).toISOString(), token_hash: null })
      .eq('user_id', userId)
      .eq('token_hash', nonceHash)
      .is('verified_at', null)
      .select('user_id');
    if (error) return { outcome: 'unavailable', userId, reason: `${HE_ENG_EMAIL_VERIFICATIONS_TABLE} update: ${error.code ?? 'error'}` };
    if (Array.isArray(data) && data.length > 0) return { outcome: 'verified', userId, reason: null };

    // Гонка: между чтением и записью ссылку уже погасил параллельный переход
    // (двойной клик, сканер) либо её заменила новая отправка.
    const again = await readHeEngEmailVerification(db, userId);
    if (again.kind === 'row' && again.row.verified_at) return { outcome: 'already_verified', userId, reason: null };
    if (again.kind === 'row') return { outcome: 'superseded', userId, reason: null };
    return { outcome: 'unavailable', userId, reason: again.kind === 'error' ? again.message : again.kind };
  } catch (e) {
    return { outcome: 'unavailable', userId, reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}
