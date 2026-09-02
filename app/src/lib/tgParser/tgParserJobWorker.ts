/**
 * Фоновое выполнение задач tg_parser_jobs (отдельный Docker worker).
 */
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { startTrace } from '@/lib/tracer';
import { parseTgUsers, type ParseResult } from '@/lib/tgParser/parser';
import { findOutreachConflict, outreachConflictMessage } from '@/lib/tgParser/accountConflict';
import { clampTgParserMaxContactsPerRun } from '@/lib/tgParser/constants';
import { normalizeTgLinks } from '@/lib/tgParser/normalizeLinks';
import type { ParsedUser, ParseProgress, TgParserAccount } from '@/lib/tgParser/types';

/** Этапы обхода человеческим языком — они попадают прямо в журнал оператору. */
const STAGE_LABEL: Record<ParseProgress['stage'], string> = {
  messages: 'авторы сообщений',
  members: 'участники',
  comments: 'комментарии под постами',
};

export type TgParserJobConfig = {
  links: string[];
  parse_chat_messages?: boolean;
  parse_chat_members?: boolean;
  parse_post_comments?: boolean;
  enrich_profile?: boolean;
  message_limit?: number;
  filter_online?: boolean;
  filter_recently?: boolean;
  max_offline_days?: number | null;
  is_target?: boolean;
  account_label?: string;
  links_summary?: string;
};

/**
 * Чекпойнт обхода: какие источники закрыты и кто уже набран.
 *
 * Гранулярность — источник: он идёт от минуты до сорока, а внутри этапа
 * восстанавливать позицию нечем (GramJS-итераторы курсор наружу не отдают).
 */
export type TgParserCheckpoint = {
  done_links: string[];
  users: ParsedUser[];
  /** Источники, которые не открылись, в формате «ссылка — причина». */
  failed_links?: string[];
};

export interface TgParserRunContext {
  signal: AbortSignal;
  checkpoint: TgParserCheckpoint | null;
  saveCheckpoint(data: TgParserCheckpoint): Promise<boolean>;
}

type TgParserLogLevel = 'info' | 'warning' | 'error';
type PgErrorLike = {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

const MAX_TEXT_CELL_LEN = Number(process.env.TG_PARSER_MAX_TEXT_CELL_LEN ?? '4000');
const MAX_MESSAGES_CELL_LEN = Number(process.env.TG_PARSER_MAX_MESSAGES_CELL_LEN ?? '12000');

function sanitizeStringCell(value: unknown, maxLen: number): string {
  const s = String(value ?? '');
  // Remove control chars that can break JSON/DB parsing.
  const noCtl = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  // Remove invalid UTF-16 surrogate halves that PostgREST may reject as invalid JSON (PGRST102).
  let cleaned = '';
  for (let i = 0; i < noCtl.length; i += 1) {
    const ch = noCtl.charCodeAt(i);
    if (ch >= 0xd800 && ch <= 0xdbff) {
      const next = i + 1 < noCtl.length ? noCtl.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cleaned += noCtl[i] + noCtl[i + 1];
        i += 1;
      } else {
        cleaned += ' ';
      }
      continue;
    }
    if (ch >= 0xdc00 && ch <= 0xdfff) {
      cleaned += ' ';
      continue;
    }
    cleaned += noCtl[i];
  }
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function sanitizeNumberCell(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function sanitizeUsersForJson(users: ParsedUser[]): ParsedUser[] {
  return users.map((u) => ({
    'ID/Username': sanitizeStringCell(u['ID/Username'], 200),
    ID: sanitizeNumberCell(u.ID),
    Username: sanitizeStringCell(u.Username, 200),
    Имя: sanitizeStringCell(u.Имя, 200),
    Фамилия: sanitizeStringCell(u.Фамилия, 200),
    'Полное имя': sanitizeStringCell(u['Полное имя'], 300),
    Пол: sanitizeStringCell(u.Пол, 50),
    Биография: sanitizeStringCell(u.Биография, MAX_TEXT_CELL_LEN),
    'Личный канал': sanitizeStringCell(u['Личный канал'], 500),
    'Статус онлайн': sanitizeStringCell(u['Статус онлайн'], 50) as ParsedUser['Статус онлайн'],
    'Последний раз в сети': sanitizeStringCell(u['Последний раз в сети'], 100),
    Сообщения: sanitizeStringCell(u.Сообщения, MAX_MESSAGES_CELL_LEN),
    'Количество сообщений': sanitizeNumberCell(u['Количество сообщений']),
    'Тип источника': sanitizeStringCell(u['Тип источника'], 50) as ParsedUser['Тип источника'],
    'Ссылка на источник': sanitizeStringCell(u['Ссылка на источник'], 1000),
    'Название источника': sanitizeStringCell(u['Название источника'], 500),
  }));
}

function stripMessages(users: ParsedUser[]): ParsedUser[] {
  return users.map((u) => ({
    ...u,
    Сообщения: '',
  }));
}

function stripHeavyText(users: ParsedUser[]): ParsedUser[] {
  return users.map((u) => ({
    ...u,
    Сообщения: '',
    Биография: '',
  }));
}

/**
 * Потолок чекпойнта. Строку переписываем целиком после КАЖДОГО источника, а
 * запись идёт обычным PostgREST-запросом — тело в единицы мегабайт проходит,
 * в десятки уже нет. 4 МБ выбраны как заведомо безопасный конверт под типовым
 * лимитом тела запроса (единицы-десятки МБ) с запасом на служебные поля.
 */
const CHECKPOINT_MAX_BYTES = Number(process.env.TG_PARSER_CHECKPOINT_MAX_BYTES ?? '4000000');

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Ужать список под потолок ДЕТЕРМИНИРОВАННО — по измеренному размеру, а не на
 * глазок, ровно как persistDoneUsersWithRetry делает это для финальной записи.
 *
 * `Сообщения` держат до 12 000 символов на человека, `Биография` — до 4 000, а
 * целевой обход набирает до 50 000 контактов: без обрезки это сотни мегабайт
 * после каждого источника. Важно, что перебор размера не даёт ошибки:
 * saveCheckpoint отвечает про владение, а не про запись, и слишком тяжёлый
 * чекпойнт просто молча не сохранится — возобновление тогда не работает вовсе.
 * Поэтому лучше отдать людей без текстов, чем не отдать никого.
 *
 * `fits: false` означает, что не помещается даже самый лёгкий вариант (десятки
 * тысяч контактов): сжимать дальше нечем, не потеряв самих людей, — отдаём как
 * есть и говорим об этом в журнале.
 */
function fitUsersInCheckpoint(users: ParsedUser[]): { users: ParsedUser[]; fits: boolean; degraded: boolean } {
  const light = sanitizeUsersForJson(stripMessages(users));
  if (jsonBytes(light) <= CHECKPOINT_MAX_BYTES) return { users: light, fits: true, degraded: false };
  const lightest = sanitizeUsersForJson(stripHeavyText(users));
  return { users: lightest, fits: jsonBytes(lightest) <= CHECKPOINT_MAX_BYTES, degraded: true };
}

function truncateText(s: string, max = 800): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function payloadStats(users: ParsedUser[]) {
  let maxMessagesLen = 0;
  let maxBioLen = 0;
  let maxSourceLen = 0;
  let usersWithCtlChars = 0;
  let totalMessagesChars = 0;
  let totalBioChars = 0;
  const ctlRe = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

  for (const u of users) {
    const msg = String(u.Сообщения ?? '');
    const bio = String(u.Биография ?? '');
    const src = String(u['Ссылка на источник'] ?? '');
    if (msg.length > maxMessagesLen) maxMessagesLen = msg.length;
    if (bio.length > maxBioLen) maxBioLen = bio.length;
    if (src.length > maxSourceLen) maxSourceLen = src.length;
    totalMessagesChars += msg.length;
    totalBioChars += bio.length;
    if (ctlRe.test(msg) || ctlRe.test(bio)) usersWithCtlChars += 1;
  }

  let jsonBytes = -1;
  let jsonError: string | null = null;
  try {
    jsonBytes = Buffer.byteLength(JSON.stringify(users), 'utf8');
  } catch (e) {
    jsonError = e instanceof Error ? e.message : String(e);
  }

  const first = users[0];
  return {
    usersCount: users.length,
    jsonBytes,
    jsonError,
    maxMessagesLen,
    maxBioLen,
    maxSourceLen,
    totalMessagesChars,
    totalBioChars,
    usersWithCtlChars,
    sampleId: first?.ID ?? null,
    sampleUsername: first?.Username ?? '',
    sampleSource: first?.['Ссылка на источник'] ?? '',
  };
}

function formatPersistFailureMessage(args: {
  mode: string;
  reason: string;
  pg?: PgErrorLike | null;
  stats?: ReturnType<typeof payloadStats>;
}): string {
  const chunks: string[] = [
    `persist fail [mode=${args.mode}]`,
    `reason=${args.reason}`,
  ];
  if (args.pg?.code) chunks.push(`pg.code=${args.pg.code}`);
  if (args.pg?.details) chunks.push(`pg.details=${truncateText(String(args.pg.details), 220)}`);
  if (args.pg?.hint) chunks.push(`pg.hint=${truncateText(String(args.pg.hint), 160)}`);
  if (args.stats) {
    chunks.push(
      `users=${args.stats.usersCount}`,
      `jsonBytes=${args.stats.jsonBytes}`,
      `maxMsg=${args.stats.maxMessagesLen}`,
      `maxBio=${args.stats.maxBioLen}`,
      `ctlUsers=${args.stats.usersWithCtlChars}`,
      `sampleId=${args.stats.sampleId ?? 'n/a'}`,
      `sampleUser=${truncateText(args.stats.sampleUsername || '', 40)}`,
    );
    if (args.stats.jsonError) chunks.push(`jsonError=${truncateText(args.stats.jsonError, 180)}`);
  }
  return truncateText(chunks.join(' | '), 1000);
}

async function writeJobLog(args: {
  jobId: string;
  jobUserId: string;
  isTarget: boolean;
  accountLabel: string | null;
  level: TgParserLogLevel;
  message: string;
}): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;
  try {
    await db.from('tg_parser_logs').insert({
      job_id: args.jobId,
      job_user_id: args.jobUserId,
      is_target: args.isTarget,
      account_label: args.accountLabel,
      level: args.level,
      message: args.message,
    });
  } catch {
    // Логи не должны ломать выполнение парсера.
  }
}

/**
 * «Чекпойнт не записался» — в журнал самой задачи, а не только в stdout.
 *
 * Отдельная экспортируемая функция, а не поле в TgParserRunContext: библиотека
 * зовёт onCheckpointUnpersisted на уровне бегунка и знает только jobId, тогда
 * как ctx создаётся под конкретный запуск. Так воркеру (задача 6) хватает
 * одной строчки `onCheckpointUnpersisted: logTgParserCheckpointUnpersisted`,
 * без собственной карты jobId → колбэк и без её времени жизни. Поля задачи
 * дочитываем сами: путь редкий, лишний SELECT на нём не жалко.
 */
export async function logTgParserCheckpointUnpersisted(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;
  try {
    const { data: job } = await db
      .from('tg_parser_jobs')
      .select('user_id, config')
      .eq('id', jobId)
      .single();
    if (!job) return;
    const cfg = (job.config ?? {}) as TgParserJobConfig;
    await writeJobLog({
      jobId,
      jobUserId: job.user_id,
      isTarget: Boolean(cfg.is_target),
      accountLabel: cfg.account_label ?? null,
      level: 'warning',
      message:
        'Чекпойнт не сохранился: при перезапуске исполнителя часть обхода будет пройдена заново',
    });
  } catch {
    // Диагностика не должна ронять воркер.
  }
}

export async function runTgParserJob(jobId: string, ctx?: TgParserRunContext): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    console.error('[tg-parser-job] supabaseAdmin missing');
    return;
  }

  const { data: job, error: loadErr } = await db
    .from('tg_parser_jobs')
    .select('id, status, config, account_id, user_id')
    .eq('id', jobId)
    .single();

  if (loadErr || !job) {
    console.error('[tg-parser-job] load failed', loadErr);
    return;
  }
  if (job.status !== 'running') return;

  const cfg = job.config as TgParserJobConfig;
  const isTarget = Boolean(cfg.is_target);
  const accountLabel = cfg.account_label ?? null;
  const jobUserId = job.user_id;
  // Второй раз, уже над сохранённым cfg: задачи, заведённые до расклейки на
  // роуте, лежат в базе со склеенными ссылками и при повторе упали бы так же.
  const { links } = normalizeTgLinks(cfg.links);

  // Продолжение после перезапуска исполнителя: закрытые источники не трогаем,
  // набранных людей подсаживаем обратно в накопитель парсера.
  const checkpoint = ctx?.checkpoint ?? null;
  const doneLinks = new Set<string>(checkpoint?.done_links ?? []);
  const remainingLinks = links.filter((l) => !doneLinks.has(l));
  // Чекпойнт читаем из БД как чужие данные: запись без числового ID села бы в
  // накопитель парсера ключом undefined и тихо сломала дедупликацию.
  const seedUsers: ParsedUser[] = (checkpoint?.users ?? []).filter(
    (u) => typeof u?.ID === 'number' && Number.isFinite(u.ID),
  );
  const failedLinks: string[] = checkpoint?.failed_links ?? [];

  await writeJobLog({
    jobId,
    jobUserId,
    isTarget,
    accountLabel,
    level: 'info',
    message: `Запуск задачи: ссылок ${links.length}, режим ${isTarget ? 'целевой' : 'обычный'}`,
  });

  if (checkpoint) {
    await writeJobLog({
      jobId,
      jobUserId,
      isTarget,
      accountLabel,
      level: 'info',
      // Счётчик найденных после возобновления просядет: контакты недобранного
      // источника отброшены вместе с ним и будут собраны заново. Говорим об
      // этом сразу, иначе падение числа выглядит как потеря данных.
      message: `Продолжаем после перезапуска: источников обработано ${links.length - remainingLinks.length} из ${links.length}, контактов уже собрано ${seedUsers.length}. Счётчик найденных может временно опуститься ниже прежнего значения — недобранный источник обходится заново`,
    });
  }

  const trace = await startTrace({
    name: 'tg-parser.job.run',
    message: cfg.account_label ?? 'TG Parser job',
    userId: job.user_id ?? null,
    jobId,
    input: {
      job_id: jobId,
      links_count: Array.isArray(cfg.links) ? cfg.links.length : 0,
      parse_chat_messages: cfg.parse_chat_messages ?? true,
      parse_chat_members: cfg.parse_chat_members ?? true,
      parse_post_comments: cfg.parse_post_comments ?? true,
      enrich_profile: Boolean(cfg.enrich_profile),
      message_limit: Math.min(5000, Math.max(10, Number(cfg.message_limit) || 100)),
      is_target: Boolean(cfg.is_target),
      account_label: cfg.account_label ?? null,
    },
  });
  if (links.length === 0) {
    const msg = 'Пустой список ссылок';
    await db
      .from('tg_parser_jobs')
      .update({
        status: 'error',
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'running');
    await writeJobLog({ jobId, jobUserId, isTarget, accountLabel, level: 'error', message: msg });
    await trace?.fail(new Error(msg), { stage: 'validate_links' });
    return;
  }

  let account: TgParserAccount | undefined;
  let max_contacts: number | null = null;
  const accountId = typeof job.account_id === 'string' ? job.account_id.trim() : '';

  if (isTarget) {
    if (!process.env.TG_TARGET_API_ID || !process.env.TG_TARGET_SESSION) {
      const msg = 'Целевой аккаунт не настроен на сервере';
      await db
        .from('tg_parser_jobs')
        .update({
          status: 'error',
          error_message: msg,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('status', 'running');
      await writeJobLog({ jobId, jobUserId, isTarget, accountLabel, level: 'error', message: msg });
      await trace?.fail(new Error(msg), { stage: 'target_account_check' });
      return;
    }
    account = {
      api_id: Number(process.env.TG_TARGET_API_ID),
      api_hash: process.env.TG_TARGET_API_HASH || '',
      session_data: process.env.TG_TARGET_SESSION,
    };
    max_contacts = clampTgParserMaxContactsPerRun(50000); // Higher limit for target parsing
  } else if (accountId) {
    const { data: row } = await db
      .from('tg_parser_accounts')
      .select('api_id, api_hash, session_data, proxy_url, max_contacts_per_run, phone')
      .eq('id', accountId)
      .eq('is_active', true)
      .single();

    // Тот же номер в работающей аутрич-кампании = гарантированный
    // AUTH_KEY_DUPLICATED через доли секунды после подключения, а при повторах —
    // сожжённая сессия. Проверяем ДО подключения (см. accountConflict.ts).
    if (row?.phone) {
      const { data: runningCampaigns } = await db
        .from('tg_outreach_campaigns')
        .select('id, name')
        // Не только running: warming (прогрев) держит сессии сутками, а paused —
        // транзитный статус, авто-резюм возвращает его в running за пять минут.
        // Проверено по CHECK-ограничению таблицы: statuses = stopped/running/paused/error/warming.
        .in('status', ['running', 'warming', 'paused']);
      const campaignById = new Map(
        ((runningCampaigns ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
      );
      if (campaignById.size > 0) {
        const { data: busyAccounts } = await db
          .from('tg_outreach_accounts')
          .select('phone, campaign_id')
          .in('campaign_id', [...campaignById.keys()]);
        const conflict = findOutreachConflict(
          row.phone,
          ((busyAccounts ?? []) as Array<{ phone: string | null; campaign_id: string }>).map((a) => ({
            phone: a.phone,
            campaignName: campaignById.get(a.campaign_id) ?? 'без названия',
          })),
        );
        if (conflict) {
          const msg = outreachConflictMessage(row.phone, conflict);
          await db
            .from('tg_parser_jobs')
            .update({ status: 'error', error_message: msg, completed_at: new Date().toISOString() })
            .eq('id', jobId)
            .eq('status', 'running');
          await writeJobLog({ jobId, jobUserId, isTarget, accountLabel, level: 'error', message: msg });
          await trace?.fail(new Error(msg), { stage: 'account_conflict' });
          return;
        }
      }
    }

    if (!row?.session_data) {
      const msg = 'Аккаунт не найден или неактивен';
      await db
        .from('tg_parser_jobs')
        .update({
          status: 'error',
          error_message: msg,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('status', 'running');
      await writeJobLog({ jobId, jobUserId, isTarget, accountLabel, level: 'error', message: msg });
      await trace?.fail(new Error(msg), { stage: 'account_check' });
      return;
    }
    account = {
      api_id: row.api_id,
      api_hash: row.api_hash,
      session_data: row.session_data,
      proxy_url: row.proxy_url || undefined,
    };
    max_contacts = clampTgParserMaxContactsPerRun(row.max_contacts_per_run);
  }

  try {
    await writeJobLog({
      jobId,
      jobUserId,
      isTarget,
      accountLabel,
      level: 'info',
      message: 'Начинаем парсинг Telegram источников',
    });

    // Прогресс: в журнал — только границы этапов, в БД — счётчик найденных.
    // Промежуточные тики (каждые 25 контактов) в журнал не пишем, иначе он
    // превратится в ленту из сотен одинаковых строк и станет нечитаемым.
    let lastProgressWriteAt = 0;
    const onProgress = async (p: ParseProgress) => {
      const source = p.title || p.link;
      if (p.phase !== 'tick') {
        await writeJobLog({
          jobId,
          jobUserId,
          isTarget,
          accountLabel,
          level: 'info',
          message: p.phase === 'start'
            ? `${source}: ${STAGE_LABEL[p.stage]} — начал`
            : `${source}: ${STAGE_LABEL[p.stage]} — готово, всего собрано ${p.total}`,
        });
      }

      // Счётчик в БД трогаем не чаще раза в 10 секунд: обновление на каждый
      // тик — это лишние сотни записей за длинный обход.
      const now = Date.now();
      if (p.phase === 'tick' && now - lastProgressWriteAt < 10_000) return;
      lastProgressWriteAt = now;
      try {
        await db
          .from('tg_parser_jobs')
          .update({
            found_count: p.total,
            progress_note: `${source} · ${STAGE_LABEL[p.stage]}`,
            progress_at: new Date().toISOString(),
          })
          .eq('id', jobId)
          .eq('status', 'running');
      } catch {
        // Прогресс — диагностика, а не результат: сбой записи не должен
        // прерывать сбор, ради которого всё и запускалось.
      }
    };

    /**
     * Чекпойнт после каждого источника.
     *
     * Размер держит fitUsersInCheckpoint: тексты сообщений (а при перегрузе и
     * биографии) в чекпойнт не попадают. Плата: у людей, набранных ДО
     * перезапуска, не будет этих полей в итоге — ровно та же деградация, до
     * которой финальная запись доходит сама под давлением размера, и она
     * несопоставимо дешевле потери всего сорокаминутного обхода.
     */
    let warnedCheckpointOversize = false;
    const onLinkDone = async (link: string, usersSoFar: ParsedUser[], failure?: string) => {
      doneLinks.add(link);
      if (failure) failedLinks.push(`${link} — ${failure}`);
      const fitted = fitUsersInCheckpoint(usersSoFar);
      if (!fitted.fits && !warnedCheckpointOversize) {
        warnedCheckpointOversize = true;
        await writeJobLog({
          jobId,
          jobUserId,
          isTarget,
          accountLabel,
          level: 'warning',
          message:
            'Слишком много контактов для чекпойнта: при перезапуске исполнителя часть обхода придётся пройти заново',
        });
      }
      // Ответ про владение игнорируем намеренно: при false библиотека уже
      // взвела ctx.signal, и обход прервётся на ближайшем контакте — отдельный
      // механизм остановки был бы вторым источником правды.
      await ctx?.saveCheckpoint({
        done_links: [...doneLinks],
        users: fitted.users,
        failed_links: failedLinks,
      });
    };

    let result: ParseResult;
    if (remainingLinks.length === 0 && checkpoint) {
      // Все источники закрыты ещё до перезапуска — обходить нечего, а пустой
      // список парсер счёл бы ошибкой конфигурации. Вердикт восстанавливаем
      // тот же, что выдал бы непрерванный обход: без этого задача, у которой
      // не открылся НИ ОДИН источник, после перезапуска отчиталась бы
      // «готово, 0 контактов» вместо ошибки.
      result =
        seedUsers.length === 0 && failedLinks.length > 0
          ? { status: 'error', error: `не удалось открыть ни один источник: ${failedLinks.join('; ')}` }
          : { status: 'ok', users: seedUsers };
    } else {
      result = await parseTgUsers({
        links: remainingLinks,
        signal: ctx?.signal,
        initialUsers: seedUsers,
        onLinkDone,
        parse_chat_messages: cfg.parse_chat_messages ?? true,
        parse_chat_members: cfg.parse_chat_members ?? true,
        parse_post_comments: cfg.parse_post_comments ?? true,
        enrich_profile: Boolean(cfg.enrich_profile),
        message_limit: Math.min(5000, Math.max(10, Number(cfg.message_limit) || 100)),
        filter_online: Boolean(cfg.filter_online),
        filter_recently: Boolean(cfg.filter_recently),
        max_offline_days: cfg.max_offline_days != null ? Number(cfg.max_offline_days) : null,
        account,
        max_contacts,
        onProgress,
      });
    }

    // Провалы источников, случившиеся ДО перезапуска, парсер этого запуска уже
    // не видит: он получил только оставшиеся ссылки. Без этого задача, у
    // которой половина источников не открылась, после перезапуска отчиталась бы
    // безупречным «успешно завершено». Ветка срабатывает только на чистом 'ok',
    // то есть когда в ЭТОМ запуске провалов не было и двойного счёта нет.
    if (result.status === 'ok' && failedLinks.length > 0) {
      result = {
        status: 'partial',
        users: result.users,
        stop_reason: 'error',
        error: `пропущены источники (${failedLinks.length} из ${links.length}): ${failedLinks.join('; ')}`,
      };
    }

    // Нас останавливают (деплой или потеря аренды) — терминальный статус НЕ
    // пишем: строка обязана остаться running, чтобы библиотека отпустила аренду
    // и соседняя реплика продолжила задачу с чекпойнта, а не начала с нуля.
    if (result.status === 'partial' && result.stop_reason === 'interrupted') {
      await writeJobLog({
        jobId,
        jobUserId,
        isTarget,
        accountLabel,
        level: 'info',
        message: 'Остановлено для перезапуска исполнителя — продолжится с чекпойнта',
      });
      await trace?.end({
        stage: 'parse',
        status: 'interrupted',
        users_count: result.users.length,
      });
      return;
    }

    const safeUsers = result.status === 'error' ? null : sanitizeUsersForJson(result.users);

    const persistTerminalState = async (
      patch: {
        status: 'done' | 'error';
        result_users?: unknown;
        stop_reason?: string | null;
        error_message?: string | null;
      },
      opts?: {
        fallbackReason?: string;
        logOnFallback?: string;
        fallbackLogLevel?: TgParserLogLevel;
        applyFallbackOnFailure?: boolean;
        persistMode?: 'full' | 'no_messages' | 'no_messages_no_bio' | 'error';
        usersSnapshot?: ParsedUser[];
        logFailureDetails?: boolean;
      },
    ): Promise<{ ok: boolean; errorMessage?: string }> => {
      const { data: updated, error: updateErr } = await db
        .from('tg_parser_jobs')
        .update({
          ...patch,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('status', 'running')
        .select('id')
        .maybeSingle();

      if (!updateErr && updated) return { ok: true };

      const pgErr = (updateErr ?? null) as PgErrorLike | null;
      const reason = pgErr?.message || opts?.fallbackReason || 'Не удалось обновить статус задачи';
      const persistMsg = `Не удалось сохранить итог задачи: ${reason}`;
      const stats = opts?.usersSnapshot ? payloadStats(opts.usersSnapshot) : undefined;
      const detailMsg = formatPersistFailureMessage({
        mode: opts?.persistMode ?? patch.status,
        reason,
        pg: pgErr,
        stats,
      });
      console.error('[tg-parser-job] final state persist failed', {
        jobId,
        reason,
        pgCode: pgErr?.code,
        pgDetails: pgErr?.details,
        pgHint: pgErr?.hint,
        targetStatus: patch.status,
        mode: opts?.persistMode ?? 'unknown',
        stats,
      });

      if (opts?.logFailureDetails) {
        await writeJobLog({
          jobId,
          jobUserId,
          isTarget,
          accountLabel,
          level: 'warning',
          message: detailMsg,
        });
      }

      if (opts?.applyFallbackOnFailure === false) {
        return { ok: false, errorMessage: persistMsg };
      }

      const { data: fallbackRow, error: fallbackErr } = await db
        .from('tg_parser_jobs')
        .update({
          status: 'error',
          stop_reason: 'persist_failed',
          error_message: truncateText(persistMsg, 900),
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('status', 'running')
        .select('id')
        .maybeSingle();

      if (fallbackErr || !fallbackRow) {
        console.error('[tg-parser-job] fallback persist failed', { jobId, fallbackErr });
      } else if (opts?.logOnFallback) {
        await writeJobLog({
          jobId,
          jobUserId,
          isTarget,
          accountLabel,
          level: opts.fallbackLogLevel ?? 'error',
          message: `${opts.logOnFallback}: ${reason}`,
        });
      }

      return { ok: false, errorMessage: persistMsg };
    };

    const persistDoneUsersWithRetry = async (args: {
      users: ParsedUser[];
      stopReason: string | null;
      errorMessage: string | null;
      fallbackReason: string;
      fallbackLogOnFailure: string;
      fallbackLogLevel?: TgParserLogLevel;
    }): Promise<{ ok: boolean; usersPersistMode?: 'full' | 'no_messages' | 'no_messages_no_bio'; errorMessage?: string }> => {
      const variants: Array<{
        mode: 'full' | 'no_messages' | 'no_messages_no_bio';
        users: ParsedUser[];
      }> = [
        { mode: 'full', users: args.users },
        { mode: 'no_messages', users: stripMessages(args.users) },
        { mode: 'no_messages_no_bio', users: stripHeavyText(args.users) },
      ];

      let lastError = 'unknown persist error';
      for (const variant of variants) {
        const persisted = await persistTerminalState(
          {
            status: 'done',
            result_users: variant.users,
            stop_reason: args.stopReason,
            error_message: args.errorMessage,
          },
          {
            fallbackReason: args.fallbackReason,
            applyFallbackOnFailure: false,
            persistMode: variant.mode,
            usersSnapshot: variant.users,
            logFailureDetails: true,
          },
        );
        if (persisted.ok) {
          if (variant.mode !== 'full') {
            await writeJobLog({
              jobId,
              jobUserId,
              isTarget,
              accountLabel,
              level: 'warning',
              message:
                variant.mode === 'no_messages'
                  ? 'Результат сохранён в облегченном виде: поле «Сообщения» очищено для стабильной записи'
                  : 'Результат сохранён в облегченном виде: очищены поля «Сообщения» и «Биография»',
            });
          }
          return { ok: true, usersPersistMode: variant.mode };
        }
        lastError = persisted.errorMessage ?? lastError;
      }

      const finalFallback = await persistTerminalState(
        {
          status: 'done',
          result_users: [],
          stop_reason: args.stopReason,
          error_message: args.errorMessage,
        },
        {
          fallbackReason: args.fallbackReason,
          logOnFallback: args.fallbackLogOnFailure,
          fallbackLogLevel: args.fallbackLogLevel ?? 'error',
          applyFallbackOnFailure: true,
          persistMode: 'error',
          usersSnapshot: [],
          logFailureDetails: true,
        },
      );
      return { ok: false, errorMessage: finalFallback.errorMessage ?? lastError };
    };

    if (result.status === 'error') {
      const persisted = await persistTerminalState(
        { status: 'error', error_message: result.error },
        {
          fallbackReason: result.error,
          logOnFallback: 'Не удалось сохранить ошибку задачи в tg_parser_jobs',
        },
      );
      await writeJobLog({
        jobId,
        jobUserId,
        isTarget,
        accountLabel,
        level: 'error',
        message: `Задача завершилась ошибкой: ${result.error}`,
      });
      await trace?.fail(
        new Error(persisted.ok ? result.error : persisted.errorMessage ?? result.error),
        { stage: 'parse', status: 'error' },
      );
      return;
    }

    if (result.status === 'partial') {
      const persisted = await persistDoneUsersWithRetry({
        users: safeUsers ?? [],
        stopReason: result.stop_reason,
        errorMessage: result.error ?? null,
        fallbackReason: result.error ?? 'partial result persist failed',
        fallbackLogOnFailure: 'Частичный результат не сохранён',
        fallbackLogLevel: 'warning',
      });
      if (!persisted.ok) {
        await trace?.fail(new Error(persisted.errorMessage ?? 'partial result persist failed'), {
          stage: 'parse',
          status: 'persist_failed',
          users_count: result.users.length,
          stop_reason: result.stop_reason,
        });
        return;
      }
      const usersForLog =
        persisted.usersPersistMode === 'full' ? result.users.length : safeUsers?.length ?? result.users.length;
      await writeJobLog({
        jobId,
        jobUserId,
        isTarget,
        accountLabel,
        level: 'warning',
        message: `Частичный результат: ${usersForLog} контактов, причина остановки: ${result.stop_reason ?? 'unknown'}`,
      });
      await trace?.end({
        stage: 'parse',
        status: 'partial',
        users_count: usersForLog,
        stop_reason: result.stop_reason,
        error: result.error ?? null,
        users_persist_mode: persisted.usersPersistMode ?? 'unknown',
      });
      return;
    }

    const persisted = await persistDoneUsersWithRetry({
      users: safeUsers ?? [],
      stopReason: null,
      errorMessage: null,
      fallbackReason: 'successful result persist failed',
      fallbackLogOnFailure: 'Итог не сохранён в tg_parser_jobs',
      fallbackLogLevel: 'error',
    });
    if (!persisted.ok) {
      await trace?.fail(new Error(persisted.errorMessage ?? 'result persist failed'), {
        stage: 'parse',
        status: 'persist_failed',
        users_count: result.users.length,
      });
      return;
    }
    const usersForLog =
      persisted.usersPersistMode === 'full' ? result.users.length : safeUsers?.length ?? result.users.length;
    await writeJobLog({
      jobId,
      jobUserId,
      isTarget,
      accountLabel,
      level: 'info',
      message: `Успешно завершено: найдено ${usersForLog} контактов`,
    });
    await trace?.end({
      stage: 'parse',
      status: 'done',
      users_count: usersForLog,
      users_persist_mode: persisted.usersPersistMode ?? 'unknown',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[tg-parser-job] run failed', err);
    await db
      .from('tg_parser_jobs')
      .update({
        status: 'error',
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .eq('status', 'running');
    await writeJobLog({
      jobId,
      jobUserId,
      isTarget,
      accountLabel,
      level: 'error',
      message: `Исключение в воркере: ${msg}`,
    });
    await trace?.fail(err, { stage: 'exception' });
  }
}
