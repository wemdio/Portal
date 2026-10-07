/**
 * Автосинк экспонентов выставок в источник «Выставки» нашего автоаутрича.
 *
 * Раз в неделю на выставку из exhibitionCatalogs.ts, пока она в окне
 * T−120…T+14 дней: одна строка polza_ru_signal_uploads на выпуск (source_key
 * `mvk:pcvexpo-2026`), строки — в polza_ru_signal_rows с ключом экспонента.
 * Сборщик (collect.ts) берёт их так же, как загруженный файл: T−90…T+14.
 *
 * Идемпотентно: уже сохранённых экспонентов не трогаем и их карточки повторно
 * не качаем; отсеянных (иностранец, нет сайта) помним в sync_meta.skipped;
 * выбывших из каталога удаляем. Новый выпуск списка ещё не вышел (у МВК
 * висит прошлогодний) — выставку пропускаем, проверим через сутки.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { EXHIBITION_CATALOGS, type ExhibitionCatalog } from './exhibitionCatalogs';
import { isForeignExhibitor, openCatalog, type ExhibitorCard, type ListedExhibitor } from './mvkCatalog';

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const DAY = 86_400_000;
const WINDOW_BEFORE_DAYS = 120;
const WINDOW_AFTER_DAYS = 14;
const RESYNC_MS = 7 * DAY;
/** Выставку без загрузки (список не вышел, сбой) пробуем не чаще раза в сутки. */
const RETRY_MS = DAY;
const CHUNK = 500;

/** Попытки в этом процессе — чтобы не стучаться каждый час в несвежий список. */
const lastAttempt = new Map<string, number>();

interface SyncMeta {
  listed?: number;
  foreign?: number;
  no_site?: number;
  card_failed?: number;
  /** Ключи отсеянных экспонентов — их карточки повторно не качаем. */
  skipped?: string[];
}

export interface ExhibitionSyncResult {
  slug: string;
  status: 'synced' | 'stale' | 'failed';
  listed: number;
  added: number;
  removed: number;
  kept: number;
  foreign: number;
  noSite: number;
  cardFailed: number;
  error?: string;
}

export function uploadKey(cfg: ExhibitionCatalog): string {
  return `${cfg.platform}:${cfg.slug}`;
}

/** Выставка в окне синка: от T−120 дней до T+14 после окончания. */
export function inSyncWindow(cfg: ExhibitionCatalog, now: Date): boolean {
  const start = Date.parse(`${cfg.eventStart}T00:00:00Z`);
  const end = Date.parse(`${cfg.eventEnd}T00:00:00Z`);
  return start - now.getTime() <= WINDOW_BEFORE_DAYS * DAY && now.getTime() - end <= WINDOW_AFTER_DAYS * DAY;
}

function rowFor(cfg: ExhibitionCatalog, uploadId: string, e: ListedExhibitor, card: ExhibitorCard) {
  return {
    upload_id: uploadId,
    kind: 'exhibitors' as const,
    source_key: e.sourceKey,
    company_name: e.name || card.name || '',
    company_website: card.website,
    inn: null,
    record_url: e.cardUrl,
    record_date: null,
    details: {
      stand: e.stand,
      country: card.country ?? e.country,
      region: card.region,
      description: card.description ?? e.description,
      email: card.email,
      legal_name: card.name && card.name !== e.name ? card.name : null,
      // stand/category — те же поля, что у загруженного файла выставки (uploads.ts).
      category: cfg.topic,
      city: cfg.city || null,
      source: cfg.platform,
    },
  };
}

/** Одна выставка: список → карточки новых → загрузка и строки. */
export async function syncExhibition(
  db: SupabaseClient,
  cfg: ExhibitionCatalog,
  now: Date,
  log: Log,
  delayMs?: number,
): Promise<ExhibitionSyncResult> {
  const result: ExhibitionSyncResult = { slug: cfg.slug, status: 'synced', listed: 0, added: 0, removed: 0, kept: 0, foreign: 0, noSite: 0, cardFailed: 0 };
  const key = uploadKey(cfg);
  const session = await openCatalog(cfg, delayMs);
  const { exhibitors, catalogYear } = session.listing;
  result.listed = exhibitors.length;
  const eventYear = Number(cfg.eventStart.slice(0, 4));
  if (catalogYear !== null && catalogYear < eventYear) {
    result.status = 'stale';
    log('info', `Выставки: ${cfg.title} — на сайте список ${catalogYear} года, ждём ${eventYear}`);
    return result;
  }
  if (!exhibitors.length) {
    // Пустой список — или участников ещё нет, или сменилась разметка: ничего не пишем и не удаляем.
    result.status = 'stale';
    log('info', `Выставки: ${cfg.title} — в каталоге пока никого`);
    return result;
  }

  const { data: existingUpload, error: upErr } = await db
    .from('polza_ru_signal_uploads')
    .select('id,sync_meta')
    .eq('source_key', key)
    .maybeSingle();
  if (upErr) throw new Error(`signal upload load failed: ${upErr.message}`);

  const existingRows = new Map<string, string>();
  if (existingUpload) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from('polza_ru_signal_rows')
        .select('id,source_key')
        .eq('upload_id', existingUpload.id)
        .range(from, from + 999);
      if (error) throw new Error(`signal rows load failed: ${error.message}`);
      for (const r of data ?? []) if (r.source_key) existingRows.set(String(r.source_key), String(r.id));
      if (!data || data.length < 1000) break;
    }
  }

  const prevMeta = (existingUpload?.sync_meta ?? {}) as SyncMeta;
  const listedKeys = new Set(exhibitors.map((e) => e.sourceKey));
  // Отсеянные, что ещё в каталоге, остаются отсеянными; выбывшие забываем.
  const skipped = new Set((prevMeta.skipped ?? []).filter((k) => listedKeys.has(k)));
  const fresh: Array<{ e: ListedExhibitor; card: ExhibitorCard }> = [];
  for (const e of exhibitors) {
    if (existingRows.has(e.sourceKey)) {
      result.kept++;
      continue;
    }
    if (skipped.has(e.sourceKey)) continue;
    let card: ExhibitorCard;
    try {
      card = await session.card(e);
    } catch (err) {
      result.cardFailed++;
      if (result.cardFailed <= 3) log('warn', `Выставки: ${cfg.title} — карточка ${e.sourceKey} не открылась`, err instanceof Error ? err.message : err);
      continue;
    }
    if (isForeignExhibitor(card.country ?? e.country, card.website)) {
      result.foreign++;
      skipped.add(e.sourceKey);
      continue;
    }
    if (!card.website) {
      result.noSite++;
      skipped.add(e.sourceKey);
      continue;
    }
    fresh.push({ e, card });
  }

  let removedIds = Array.from(existingRows).filter(([k]) => !listedKeys.has(k)).map(([, id]) => id);
  // Каталог разом «потерял» больше половины — скорее оборвалось листание, чем ушли участники.
  if (existingRows.size >= 20 && removedIds.length > existingRows.size / 2) {
    log('warn', `Выставки: ${cfg.title} — из каталога пропало ${removedIds.length} из ${existingRows.size}, строки не удаляем`);
    result.kept += removedIds.length;
    removedIds = [];
  }
  const meta: SyncMeta = {
    listed: exhibitors.length,
    foreign: result.foreign,
    no_site: result.noSite,
    card_failed: result.cardFailed,
    skipped: Array.from(skipped),
  };
  const { data: upload, error: saveErr } = await db
    .from('polza_ru_signal_uploads')
    .upsert(
      {
        kind: 'exhibitors',
        title: cfg.title,
        event_start: cfg.eventStart,
        event_end: cfg.eventEnd,
        official_url: cfg.officialUrl,
        catalog_year: catalogYear,
        file_name: null,
        source: cfg.platform,
        source_key: key,
        rows_total: result.kept + fresh.length,
        synced_at: now.toISOString(),
        sync_meta: meta,
      },
      { onConflict: 'source_key' },
    )
    .select('id')
    .single();
  if (saveErr || !upload) throw new Error(`signal upload save failed: ${saveErr?.message ?? 'no row'}`);

  for (let i = 0; i < fresh.length; i += CHUNK) {
    const { error } = await db
      .from('polza_ru_signal_rows')
      .upsert(fresh.slice(i, i + CHUNK).map(({ e, card }) => rowFor(cfg, String(upload.id), e, card)), {
        onConflict: 'upload_id,source_key',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`signal rows save failed: ${error.message}`);
  }
  for (let i = 0; i < removedIds.length; i += CHUNK) {
    const { error } = await db.from('polza_ru_signal_rows').delete().in('id', removedIds.slice(i, i + CHUNK));
    if (error) throw new Error(`signal rows delete failed: ${error.message}`);
  }
  result.added = fresh.length;
  result.removed = removedIds.length;
  log(
    'info',
    `Выставки: ${cfg.title} — в каталоге ${result.listed}, новых ${result.added}, было ${result.kept}, выбыло ${result.removed}, иностранцев ${result.foreign}, без сайта ${result.noSite}, сбоев карточек ${result.cardFailed}`,
  );
  return result;
}

/**
 * Тик воркера (раз в час): выставки в окне, синкнутые больше недели назад
 * (или ни разу), по одной. Сбой одной выставки остальные не роняет.
 */
export async function syncExhibitorCatalogs(
  db: SupabaseClient,
  now: Date,
  log: Log,
  catalogs: ExhibitionCatalog[] = EXHIBITION_CATALOGS,
): Promise<ExhibitionSyncResult[]> {
  const active = catalogs.filter((c) => inSyncWindow(c, now));
  if (!active.length) return [];
  const { data, error } = await db
    .from('polza_ru_signal_uploads')
    .select('source_key,synced_at')
    .in('source_key', active.map(uploadKey));
  if (error) throw new Error(`signal uploads load failed: ${error.message}`);
  const syncedAt = new Map((data ?? []).map((r) => [String(r.source_key), r.synced_at ? Date.parse(String(r.synced_at)) : 0]));

  const results: ExhibitionSyncResult[] = [];
  for (const cfg of active) {
    const key = uploadKey(cfg);
    const last = syncedAt.get(key) ?? 0;
    if (now.getTime() - last < RESYNC_MS) continue;
    if (now.getTime() - (lastAttempt.get(key) ?? 0) < RETRY_MS) continue;
    lastAttempt.set(key, now.getTime());
    try {
      results.push(await syncExhibition(db, cfg, now, log));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', `Выставки: ${cfg.title} — синк не удался`, message);
      results.push({ slug: cfg.slug, status: 'failed', listed: 0, added: 0, removed: 0, kept: 0, foreign: 0, noSite: 0, cardFailed: 0, error: message });
    }
  }
  return results;
}
