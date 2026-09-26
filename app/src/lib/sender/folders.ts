import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { EDITABLE_CAMPAIGN_STATUSES, SenderOpError } from './campaignOps';
import type { MailboxStatus } from './types';

/**
 * Папки «Рассылки» (sender_folders, миграция 20260926_0002): «Автоаутрич RU»
 * и «Автоаутрич EN». Папка — это настройки, которые новая рассылка
 * автоаутрича копирует себе в момент создания (lib/outreachSender/upload.ts):
 * ящики, окно отправки, паузы между письмами и задержки писем 2–4.
 *
 * Здесь — чтение папок для вкладки кампаний, правка их настроек и ящики папки
 * для кампании, которую запускают без ящиков. Проверки правки строже формы
 * кампании: ошибка в папке (неизвестный пояс, окно «с 18 до 9», ни одного
 * дня) разъехалась бы сразу по всем будущим рассылкам.
 */

export interface FolderMailbox {
  id: string;
  email: string;
  status: MailboxStatus;
  enabled: boolean;
}

export interface FolderView {
  id: string;
  key: string;
  name: string;
  timezone: string;
  send_hour_from: number;
  send_hour_to: number;
  /** 1 = понедельник … 7 = воскресенье. */
  send_weekdays: number[];
  gap_seconds: number;
  gap_jitter_seconds: number;
  /** Задержки писем 2, 3, 4 от предыдущего письма, в часах. */
  step_delays_hours: number[];
  updated_at: string;
  /** Ящики папки, которые ещё существуют, в порядке выбора. */
  mailboxes: FolderMailbox[];
  mailboxCount: number;
  /** Проверены и с галочкой «берём в рассылку» — только с таких уходят письма. */
  workingMailboxCount: number;
  campaignCount: number;
}

/** Тело PATCH: всё необязательно, меняется только присланное. */
export interface FolderPatchInput {
  name?: unknown;
  timezone?: unknown;
  sendHourFrom?: unknown;
  sendHourTo?: unknown;
  sendWeekdays?: unknown;
  gapSeconds?: unknown;
  gapJitterSeconds?: unknown;
  stepDelaysHours?: unknown;
  mailboxIds?: unknown;
}

const FOLDER_COLUMNS =
  'id, key, name, timezone, send_hour_from, send_hour_to, send_weekdays, gap_seconds, gap_jitter_seconds, step_delays_hours, mailbox_ids, updated_at';
/** Папки автоаутричей — первыми и в этом порядке, остальные — по названию. */
const FOLDER_ORDER = ['auto_ru', 'auto_en'];
/** Ящиков за один запрос: id уезжают в адрес запроса — как MAILBOX_CHUNK в campaignOps. */
const MAILBOX_CHUNK = 50;
/** Писем после первого: цепочка обоих автоаутричей — четыре письма. */
const FOLLOW_UPS = 3;
/** Задержка письма — от часа до 30 дней, как у шага в форме кампании. */
const MIN_DELAY_HOURS = 1;
const MAX_DELAY_HOURS = 720;
/** Пауза между письмами одного ящика — пределы тех же полей в форме кампании. */
const MAX_GAP_SECONDS = 3600;
const MAX_NAME_LENGTH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FolderRow {
  id: string;
  key: string;
  name: string;
  timezone: string;
  send_hour_from: number;
  send_hour_to: number;
  send_weekdays: number[] | null;
  gap_seconds: number;
  gap_jitter_seconds: number;
  step_delays_hours: number[] | null;
  mailbox_ids: string[] | null;
  updated_at: string;
}

function requireDb() {
  if (!supabaseAdmin) throw new SenderOpError('Сервис не настроен', 503);
  return supabaseAdmin;
}

/** Папки автоаутричей: заливка находит их по ключу auto_ru / auto_en. */
export function isAutoFolderKey(key: string): boolean {
  return key.startsWith('auto_');
}

/** С ящика действительно уходят письма — те же условия, что у планировщика. */
function isWorking(mailbox: FolderMailbox): boolean {
  return mailbox.status === 'verified' && mailbox.enabled;
}

/**
 * Существующие ящики из списка. У элементов mailbox_ids нет внешнего ключа:
 * удалённый ящик остаётся в массиве папки, и считать его нельзя — шапка папки
 * обещала бы ящики, которых уже нет. Не прочитали — ошибка, а не пустой
 * список: «ящиков: 0» при сбое базы выглядело бы как сброшенные настройки.
 */
async function loadMailboxes(ids: string[]): Promise<Map<string, FolderMailbox>> {
  const db = requireDb();
  const out = new Map<string, FolderMailbox>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += MAILBOX_CHUNK) {
    const { data, error } = await db
      .from('sender_mailboxes')
      .select('id, email, status, enabled')
      .in('id', unique.slice(i, i + MAILBOX_CHUNK));
    if (error) throw new SenderOpError(error.message, 500);
    for (const row of data ?? []) {
      out.set(String(row.id), {
        id: String(row.id),
        email: String(row.email),
        status: row.status as MailboxStatus,
        enabled: row.enabled === true,
      });
    }
  }
  return out;
}

/** Ящики папки в порядке выбора — только существующие. */
function folderMailboxes(ids: string[] | null, known: Map<string, FolderMailbox>): FolderMailbox[] {
  return [...new Set((ids ?? []).map(String))]
    .map((id) => known.get(id))
    .filter((mailbox): mailbox is FolderMailbox => Boolean(mailbox));
}

async function countCampaigns(folderId: string): Promise<number> {
  const { count, error } = await requireDb()
    .from('sender_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('folder_id', folderId);
  if (error) throw new SenderOpError(error.message, 500);
  return count ?? 0;
}

function displayRank(key: string): number {
  const index = FOLDER_ORDER.indexOf(key);
  return index === -1 ? FOLDER_ORDER.length : index;
}

async function readFolders(onlyId?: string): Promise<FolderView[]> {
  let query = requireDb().from('sender_folders').select(FOLDER_COLUMNS);
  if (onlyId) query = query.eq('id', onlyId);
  const { data, error } = await query;
  if (error) throw new SenderOpError(error.message, 500);
  const rows = (data ?? []) as unknown as FolderRow[];

  const [known, campaignCounts] = await Promise.all([
    loadMailboxes(rows.flatMap((row) => (row.mailbox_ids ?? []).map(String))),
    Promise.all(rows.map((row) => countCampaigns(String(row.id)))),
  ]);

  return rows
    .map((row, index): FolderView => {
      const mailboxes = folderMailboxes(row.mailbox_ids, known);
      return {
        id: String(row.id),
        key: String(row.key),
        name: String(row.name),
        timezone: String(row.timezone),
        send_hour_from: Number(row.send_hour_from),
        send_hour_to: Number(row.send_hour_to),
        send_weekdays: (row.send_weekdays ?? []).map(Number),
        gap_seconds: Number(row.gap_seconds),
        gap_jitter_seconds: Number(row.gap_jitter_seconds),
        step_delays_hours: (row.step_delays_hours ?? []).map(Number),
        updated_at: String(row.updated_at),
        mailboxes,
        mailboxCount: mailboxes.length,
        workingMailboxCount: mailboxes.filter(isWorking).length,
        campaignCount: campaignCounts[index],
      };
    })
    .sort((a, b) => displayRank(a.key) - displayRank(b.key) || a.name.localeCompare(b.name, 'ru'));
}

/** Все папки с ящиками и счётчиками — в том порядке, в каком их показывает вкладка. */
export function listFolders(): Promise<FolderView[]> {
  return readFolders();
}

// ── Правка настроек ─────────────────────────────────────────────────────────

function numberOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return Number.NaN;
}

/** Целое в пределах, иначе ошибка для человека. Дробное округляем: поля на экране числовые. */
function intInRange(value: unknown, min: number, max: number, message: string): number {
  const n = Math.round(numberOf(value));
  if (!Number.isFinite(n) || n < min || n > max) throw new SenderOpError(message, 400);
  return n;
}

/**
 * Пояс в том написании, в каком его понимает Intl: тем же Intl окно отправки
 * считает планировщик (sendWindow.ts). Пояс, которого Intl не знает, ронял бы
 * планирование каждой рассылки папки — такой не сохраняем. Заодно
 * «europe/moscow» приводится к «Europe/Moscow».
 */
export function canonicalTimezone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Сохранить настройки папки: меняется только присланное. Ящики сохраняются
 * только существующие; сколько из присланных уже удалены — в droppedMailboxes.
 *
 * Правка действует на рассылки, созданные после неё: уже созданная рассылка
 * живёт по своим настройкам (миграция 20260926_0002), кроме черновика без
 * ящиков — он возьмёт ящики папки при запуске (fillPoolFromFolder).
 */
export async function updateFolder(
  id: string,
  input: FolderPatchInput,
): Promise<{ folder: FolderView; droppedMailboxes: number }> {
  // Кривой id дал бы 500 «invalid input syntax for type uuid» вместо «не найдена».
  if (!UUID_RE.test(id)) throw new SenderOpError('Папка не найдена', 404);
  const db = requireDb();
  const { data: current, error } = await db
    .from('sender_folders')
    .select('id, key, name, send_hour_from, send_hour_to')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SenderOpError(error.message, 500);
  if (!current) throw new SenderOpError('Папка не найдена', 404);

  const patch: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (isAutoFolderKey(String(current.key))) {
      // Название папки автоаутрича — часть подсказок на экране запуска аутрича
      // («Выберите ящики в настройках папки “Автоаутрич RU”»): переименованную
      // там было бы не найти.
      if (name !== String(current.name)) throw new SenderOpError('Название папки автоаутрича не меняется', 400);
    } else {
      if (!name) throw new SenderOpError('Укажите название папки', 400);
      if (name.length > MAX_NAME_LENGTH) {
        throw new SenderOpError(`Название папки — не длиннее ${MAX_NAME_LENGTH} символов`, 400);
      }
      patch.name = name;
    }
  }

  if (input.timezone !== undefined) {
    const raw = typeof input.timezone === 'string' ? input.timezone.trim() : '';
    if (!raw) throw new SenderOpError('Укажите часовой пояс', 400);
    const timezone = raw.length <= 64 ? canonicalTimezone(raw) : null;
    if (!timezone) {
      throw new SenderOpError(
        `Неизвестный часовой пояс «${raw.slice(0, 64)}» — выберите из списка или впишите в виде Europe/Moscow`,
        400,
      );
    }
    patch.timezone = timezone;
  }

  if (input.sendHourFrom !== undefined || input.sendHourTo !== undefined) {
    // Пришла одна граница — вторую сверяем с сохранённой: окно «с 18 до 9»
    // не должно проскочить по частям.
    const from =
      input.sendHourFrom !== undefined
        ? intInRange(input.sendHourFrom, 0, 23, 'Начало окна отправки — час от 0 до 23')
        : Number(current.send_hour_from);
    const to =
      input.sendHourTo !== undefined
        ? intInRange(input.sendHourTo, 1, 24, 'Конец окна отправки — час от 1 до 24')
        : Number(current.send_hour_to);
    if (to <= from) throw new SenderOpError('Конец окна отправки должен быть позже начала', 400);
    if (input.sendHourFrom !== undefined) patch.send_hour_from = from;
    if (input.sendHourTo !== undefined) patch.send_hour_to = to;
  }

  if (input.sendWeekdays !== undefined) {
    if (!Array.isArray(input.sendWeekdays)) throw new SenderOpError('Выберите дни отправки', 400);
    const days = input.sendWeekdays.map((day) =>
      intInRange(day, 1, 7, 'Дни отправки — от 1 (понедельник) до 7 (воскресенье)'),
    );
    const unique = [...new Set(days)].sort((a, b) => a - b);
    // Рассылка без дней не отправит ничего и никогда — и не скажет почему.
    if (!unique.length) throw new SenderOpError('Выберите хотя бы один день отправки', 400);
    patch.send_weekdays = unique;
  }

  if (input.gapSeconds !== undefined) {
    patch.gap_seconds = intInRange(
      input.gapSeconds,
      0,
      MAX_GAP_SECONDS,
      `Пауза между письмами — от 0 до ${MAX_GAP_SECONDS} секунд`,
    );
  }
  if (input.gapJitterSeconds !== undefined) {
    patch.gap_jitter_seconds = intInRange(
      input.gapJitterSeconds,
      0,
      MAX_GAP_SECONDS,
      `Случайная добавка к паузе — от 0 до ${MAX_GAP_SECONDS} секунд`,
    );
  }

  if (input.stepDelaysHours !== undefined) {
    // Ровно три: заливка берёт задержку письма N из элемента N − 2, и
    // короткий массив молча заменился бы там днём по умолчанию.
    if (!Array.isArray(input.stepDelaysHours) || input.stepDelaysHours.length !== FOLLOW_UPS) {
      throw new SenderOpError('Укажите, через сколько дней уходят письма 2, 3 и 4', 400);
    }
    patch.step_delays_hours = input.stepDelaysHours.map((hours) =>
      intInRange(
        hours,
        MIN_DELAY_HOURS,
        MAX_DELAY_HOURS,
        'Письмо цепочки уходит не раньше чем через час и не позже чем через 30 дней после предыдущего',
      ),
    );
  }

  let droppedMailboxes = 0;
  if (input.mailboxIds !== undefined) {
    const list = input.mailboxIds;
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !UUID_RE.test(item))) {
      throw new SenderOpError('Некорректный список ящиков', 400);
    }
    const wanted = [...new Set((list as string[]).map((item) => item.toLowerCase()))];
    const known = await loadMailboxes(wanted);
    const kept = wanted.filter((mailboxId) => known.has(mailboxId));
    // Ящик удалили, пока окно выбора было открыто: сохраняем остальные, а не
    // отказываем во всём сохранении.
    droppedMailboxes = wanted.length - kept.length;
    patch.mailbox_ids = kept;
  }

  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    const { error: updateError } = await db.from('sender_folders').update(patch).eq('id', id);
    if (updateError) throw new SenderOpError(updateError.message, 500);
  }

  const [folder] = await readFolders(id);
  if (!folder) throw new SenderOpError('Папка не найдена', 404);
  return { folder, droppedMailboxes };
}

// ── Ящики папки при запуске ─────────────────────────────────────────────────

/**
 * Кампания папки без ящиков берёт ящики папки при запуске — и с экрана
 * запуска аутрича, и кнопкой «Запустить» в списке кампаний.
 *
 * Заливка создаёт рассылку-черновик без ящиков, если в папке их ещё не
 * выбрали (createCampaign, allowEmptyPool): выбрать их в папке после заливки
 * естественнее, чем чинить пул каждой рассылки. Без этого кнопка «Запустить»
 * в «Рассылке» отвечала бы «В кампании нет ящиков», хотя в папке они уже есть.
 *
 * Непустой пул не трогаем — его могли поправить руками. Пока в папке нет ни
 * одного рабочего ящика, пул не заполняем вовсе: иначе он стал бы непустым из
 * непроверенных ящиков, и выбор рабочих в папке эту рассылку уже не спас бы.
 * Функция одна на обе кнопки: запуск с экрана аутрича
 * (lib/outreachSender/upload.ts) зовёт её же.
 */
export async function fillPoolFromFolder(campaignId: string): Promise<number> {
  // Кривой id — не наша забота: «Кампания не найдена» скажет startCampaign.
  if (!UUID_RE.test(campaignId)) return 0;
  const db = requireDb();
  const { data: campaign, error } = await db
    .from('sender_campaigns')
    .select('id, status, folder_id')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) throw new SenderOpError(error.message, 500);
  // Нет кампании, нет папки или кампания уже едет — решает startCampaign.
  if (!campaign?.folder_id || !EDITABLE_CAMPAIGN_STATUSES.includes(String(campaign.status))) return 0;

  const { count, error: poolError } = await db
    .from('sender_campaign_mailboxes')
    .select('mailbox_id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);
  if (poolError) throw new SenderOpError(poolError.message, 500);
  if (count) return 0;

  const { data: folder, error: folderError } = await db
    .from('sender_folders')
    .select('name, mailbox_ids')
    .eq('id', String(campaign.folder_id))
    .maybeSingle();
  if (folderError) throw new SenderOpError(folderError.message, 500);
  if (!folder) return 0;

  const ids = ((folder.mailbox_ids ?? []) as unknown[]).map(String);
  const mailboxes = folderMailboxes(ids, await loadMailboxes(ids));
  if (!mailboxes.length) throw new SenderOpError(`Выберите ящики в настройках папки “${folder.name}”`, 422);
  if (!mailboxes.some(isWorking)) {
    throw new SenderOpError(
      `В папке “${folder.name}” нет проверенных ящиков: письма уходят только с ящиков, которые прошли проверку входа и отмечены галочкой — выберите такие в настройках папки`,
      422,
    );
  }

  const { error: insertError } = await db
    .from('sender_campaign_mailboxes')
    .upsert(
      mailboxes.map((mailbox) => ({ campaign_id: campaignId, mailbox_id: mailbox.id })),
      { onConflict: 'campaign_id,mailbox_id', ignoreDuplicates: true },
    );
  if (insertError) throw new SenderOpError(insertError.message, 500);
  return mailboxes.length;
}
