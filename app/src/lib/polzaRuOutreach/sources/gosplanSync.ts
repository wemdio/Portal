/**
 * Ежедневный синк ГосПлан → загрузки сигналов автоаутрича:
 * 44-ФЗ → kind 'contracts', 223-ФЗ → kind 'tenders'.
 *
 * Тик воркера автоаутрича (app/worker/polzaOutreach.ts). День D по Москве
 * берём после 06:00 МСК D+1 — ГосПлан подтягивает ЕИС с задержкой в часы.
 * Курсор — polza_ru_gosplan_sync.synced_through по закону; день кладётся одной
 * загрузкой с auto_source 'gosplan:<закон>:<день>' (уникальна), так что
 * повторный прогон того же дня строк не задваивает.
 *
 * Строка = поставщик-юрлицо с его самым крупным контрактом за день. Названия:
 * сначала companies_directory по ИНН (≈80% поставщиков, 07.10.2026), остальным —
 * полный документ контракта в пределах GOSPLAN_DETAIL_LIMIT. Без названия
 * строку не кладём: ни сайта, ни имени для письма у неё нет.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  GosplanClient,
  GosplanStopped,
  contractUrl,
  gosplanConfigFromEnv,
  pickWins,
  type GosplanConfig,
  type GosplanLaw,
  type GosplanWin,
} from './gosplan';

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

// 223-ФЗ не берём: за 05.10.2026 из 933 договоров от 3 млн ₽ поставщик не
// указан ни в одном — ни в списке, ни в полном документе ГосПлана.
const LAWS: Array<{ law: GosplanLaw; kind: 'contracts' | 'tenders'; label: string }> = [
  { law: 'fz44', kind: 'contracts', label: '44-ФЗ' },
];

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
/** День D закрываем после 06:00 МСК D+1. */
const SETTLE_MS = 6 * 60 * 60 * 1000;
/** После сбоя закон не трогаем час — не долбим лежащий API каждые 15 минут. */
const RETRY_AFTER_ERROR_MS = 60 * 60 * 1000;
const ROWS_CHUNK = 500;
const DIRECTORY_CHUNK = 200;

let disabledLogged = false;
/** Закон → последний загруженный день: пока он свежий, в базу за курсором не ходим. */
const doneThrough = new Map<GosplanLaw, string>();
const retryAt = new Map<GosplanLaw, number>();

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Последний день по Москве, который пора загрузить. */
export function lastSettledMskDay(now: Date): string {
  return addDays(new Date(now.getTime() + MSK_OFFSET_MS - SETTLE_MS).toISOString().slice(0, 10), -1);
}

function ruDate(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
}

function backfillDays(): number {
  const n = Number(process.env.GOSPLAN_BACKFILL_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 31) : 3;
}

/** Названия по ИНН из companies_directory (первое непустое). */
async function directoryNames(db: SupabaseClient, inns: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(inns));
  for (let i = 0; i < uniq.length; i += DIRECTORY_CHUNK) {
    const { data, error } = await db
      .from('companies_directory')
      .select('inn,name')
      .in('inn', uniq.slice(i, i + DIRECTORY_CHUNK));
    if (error) throw new Error(`companies_directory: ${error.message}`);
    for (const r of data ?? []) {
      const name = String(r.name ?? '').trim();
      if (name && !out.has(String(r.inn))) out.set(String(r.inn), name);
    }
  }
  return out;
}

export interface GosplanDayStats {
  day: string;
  contracts: number;
  wins: number;
  rows: number;
  requests: number;
  skipped?: 'exists';
}

async function syncDay(
  db: SupabaseClient,
  client: GosplanClient,
  cfg: GosplanConfig,
  spec: (typeof LAWS)[number],
  day: string,
): Promise<GosplanDayStats> {
  const autoSource = `gosplan:${spec.law}:${day}`;
  const requestsBefore = client.requests;
  const { data: existing, error: exErr } = await db
    .from('polza_ru_signal_uploads')
    .select('id')
    .eq('auto_source', autoSource)
    .maybeSingle();
  if (exErr) throw new Error(`signal uploads: ${exErr.message}`);
  if (existing) return { day, contracts: 0, wins: 0, rows: 0, requests: 0, skipped: 'exists' };

  const contracts = await client.contractsForDay(spec.law, day);
  const wins = pickWins(spec.law, contracts, cfg.minPrice);
  const names = await directoryNames(db, wins.flatMap((w) => (w.customerInn ? [w.supplierInn, w.customerInn] : [w.supplierInn])));

  // Полные документы: сперва поставщики без названия, затем — ради заказчика — крупные контракты.
  const needsDetail = (w: GosplanWin) => !names.has(w.supplierInn) || (w.customerInn !== null && !names.has(w.customerInn));
  const queue = [...wins.filter((w) => !names.has(w.supplierInn)), ...wins.filter((w) => names.has(w.supplierInn))];
  let budget = cfg.detailLimit;
  for (const w of queue) {
    if (budget <= 0) break;
    if (!needsDetail(w)) continue;
    budget -= 1;
    try {
      const p = await client.parties(spec.law, w.regNum, w.supplierInn, w.customerInn);
      if (p.supplierName && !names.has(w.supplierInn)) names.set(w.supplierInn, p.supplierName);
      if (p.customerName && w.customerInn && !names.has(w.customerInn)) names.set(w.customerInn, p.customerName);
    } catch (err) {
      // Один документ не отдался — строка просто останется без названия.
      if (err instanceof GosplanStopped) throw err;
    }
  }

  const rows = wins
    .filter((w) => names.has(w.supplierInn))
    .map((w) => ({
      kind: spec.kind,
      company_name: names.get(w.supplierInn) as string,
      company_website: null,
      inn: w.supplierInn,
      record_url: contractUrl(spec.law, w.regNum),
      record_date: day,
      details: {
        contract_number: w.regNum,
        subject: w.subject,
        amount: w.amount,
        customer: w.customerInn ? names.get(w.customerInn) ?? null : null,
        customer_inn: w.customerInn,
        purchase_number: w.purchaseNumber,
        law: spec.label,
        source: 'gosplan',
      },
    }));

  const stats = { day, contracts: contracts.length, wins: wins.length, rows: rows.length, requests: client.requests - requestsBefore };
  // Пустой день загрузкой не кладём — не засоряем список; курсор всё равно сдвинется.
  if (!rows.length) return stats;

  const { data: upload, error: upErr } = await db
    .from('polza_ru_signal_uploads')
    .insert({
      kind: spec.kind,
      title: `ГосПлан ${spec.label} · ${ruDate(day)}`,
      official_url: 'https://gosplan.info/',
      rows_total: rows.length,
      auto_source: autoSource,
    })
    .select('id')
    .single();
  // Параллельный прогон успел первым — день уже загружен.
  if (upErr?.code === '23505') return { day, contracts: 0, wins: 0, rows: 0, requests: 0, skipped: 'exists' };
  if (upErr || !upload) throw new Error(`signal uploads insert: ${upErr?.message ?? 'нет строки'}`);

  for (let i = 0; i < rows.length; i += ROWS_CHUNK) {
    const { error } = await db
      .from('polza_ru_signal_rows')
      .insert(rows.slice(i, i + ROWS_CHUNK).map((r) => ({ ...r, upload_id: upload.id })));
    if (error) {
      // Без половины строк загрузку не оставляем: день перезальётся при повторе.
      await db.from('polza_ru_signal_uploads').delete().eq('id', upload.id);
      throw new Error(`signal rows insert: ${error.message}`);
    }
  }

  return stats;
}

async function saveState(db: SupabaseClient, law: GosplanLaw, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('polza_ru_gosplan_sync')
    .upsert({ law, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'law' });
  if (error) throw new Error(`polza_ru_gosplan_sync: ${error.message}`);
}

/**
 * Один тик: по каждому закону догружает дни от курсора до вчера (не дальше
 * GOSPLAN_BACKFILL_DAYS назад, по умолчанию 3). Нет настроек — одна info-строка и выход.
 */
export async function runGosplanSyncTick(
  db: SupabaseClient,
  now: Date,
  log: Log,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const cfg = gosplanConfigFromEnv();
  if (!cfg) {
    if (!disabledLogged) log('info', 'ГосПлан: синк контрактов выключен (GOSPLAN_ENABLED=0)');
    disabledLogged = true;
    return;
  }

  const lastDay = lastSettledMskDay(now);
  const floor = addDays(lastDay, -(backfillDays() - 1));
  let client: GosplanClient | null = null;

  for (const spec of LAWS) {
    if (shouldStop()) return;
    if ((doneThrough.get(spec.law) ?? '') >= lastDay) continue;
    if ((retryAt.get(spec.law) ?? 0) > now.getTime()) continue;

    const { data: state, error } = await db
      .from('polza_ru_gosplan_sync')
      .select('synced_through')
      .eq('law', spec.law)
      .maybeSingle();
    if (error) {
      log('warn', `ГосПлан ${spec.label}: курсор не прочитался`, error.message);
      continue;
    }
    const through = state?.synced_through ? String(state.synced_through) : null;
    let day = through ? addDays(through, 1) : floor;
    if (day < floor) day = floor;

    client ??= new GosplanClient(cfg, { shouldStop });
    for (; day <= lastDay; day = addDays(day, 1)) {
      if (shouldStop()) return;
      try {
        const stats = await syncDay(db, client, cfg, spec, day);
        await saveState(db, spec.law, { synced_through: day, last_run_at: new Date().toISOString(), last_error: null, last_stats: stats });
        log('info', `ГосПлан ${spec.label} за ${day}: ${stats.skipped ? 'уже загружен' : `контрактов ${stats.contracts}, юрлиц ${stats.wins}, в базу ${stats.rows}, запросов ${stats.requests}`}`);
      } catch (err) {
        if (shouldStop()) return;
        const message = err instanceof Error ? err.message : String(err);
        retryAt.set(spec.law, Date.now() + RETRY_AFTER_ERROR_MS);
        log('warn', `ГосПлан ${spec.label} за ${day}: не загрузился, повтор через час`, message);
        await saveState(db, spec.law, { last_run_at: new Date().toISOString(), last_error: message.slice(0, 1000) }).catch(() => {});
        break;
      }
    }
    if (day > lastDay) doneThrough.set(spec.law, lastDay);
  }
}
