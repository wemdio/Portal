/**
 * Server-side load/save для `database_spreadsheet_states`.
 *
 * Зачем существует:
 *
 * 1. **Совместимость с state_compressed (миграция 20260518_0001).**
 *    Frontend всё пишет в `state_compressed` (gzip+base64), а несжатую
 *    колонку `state` оставляет NULL. Раньше серверные apply-функции
 *    (applyEnrichmentResults / applyBriefScoringResults / applySignalJobResults)
 *    читали ТОЛЬКО `state` — для всех новых юзеров это значило молчаливый
 *    no-op («что хотел применить? — а у юзера state=null, выходим»).
 *    Никто не замечал, потому что frontend polling успешно подтягивал
 *    результаты через свой канал. Жалоба Оли 26 мая («64 email в БД,
 *    в таблице 1») вылезла, когда polling завис — серверный safety-net
 *    оказался тоже сломан.
 *
 * 2. **Optimistic Concurrency Control через CAS на updated_at.**
 *    Без CAS server apply во время работы юзера приводил бы к lost updates:
 *    юзер правит ячейку B5 → frontend пишет state_compressed → worker
 *    параллельно read-modify-write'ит state_compressed без учёта B5 →
 *    изменения юзера теряются. CAS WHERE updated_at = $loaded гарантирует:
 *    если в окне load→save кто-то ещё успел писнуть — наш save no-op'ом
 *    отбрасывается, идемпотентно retry'имся на следующем цикле.
 *
 * Совместимость gzip:
 *   - Frontend: CompressionStream('gzip') → base64 (browser API)
 *   - Server: zlib.gzip → Buffer.toString('base64') (Node std lib)
 *   - gzip — стандарт RFC 1952, формат бинарно идентичный.
 *
 * Где используется: applyJobResults.ts (enrichment + brief scoring),
 * applySignalJobResults.ts (extractor signals).
 */

import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const gzipP = promisify(gzip);
const gunzipP = promisify(gunzip);

export type SpreadsheetTab = {
  id: string;
  name: string;
  data: string[][];
};

export type SpreadsheetState = {
  version?: number;
  tabs: SpreadsheetTab[];
  activeTabId?: string;
  tabCounter?: number;
  columnWidths?: Record<string, number[]> | number[];
  savedAt?: number;
};

export type LoadedState = {
  state: SpreadsheetState;
  /** ISO-строка updated_at в момент чтения; нужна для CAS на save. */
  loadedUpdatedAt: string;
};

/**
 * Читает state юзера. Приоритет — `state_compressed` (новая схема),
 * fallback на `state` (старые записи до миграции).
 *
 * Возвращает null если:
 *   - supabaseAdmin не сконфигурирован,
 *   - строки нет (юзер ни разу не открывал спредшит),
 *   - decompress упал на повреждённом base64,
 *   - JSON.parse упал на невалидном теле.
 *
 * Никогда не throws — все ошибки конвертируются в null. Caller
 * (apply-функция) решает что делать (обычно — log + return false).
 */
export async function loadCompressedState(userId: string): Promise<LoadedState | null> {
  if (!supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('database_spreadsheet_states')
      .select('state, state_compressed, updated_at')
      .eq('user_id', userId)
      .maybeSingle<{
        state: SpreadsheetState | string | null;
        state_compressed: string | null;
        updated_at: string;
      }>();
    if (error || !data) return null;

    let state: SpreadsheetState | null = null;
    if (data.state_compressed) {
      try {
        const buf = Buffer.from(data.state_compressed, 'base64');
        const decompressed = await gunzipP(buf);
        state = JSON.parse(decompressed.toString('utf-8')) as SpreadsheetState;
      } catch {
        // Битый compressed — пробуем fallback на state.
        state = null;
      }
    }
    if (!state && data.state) {
      state = typeof data.state === 'string'
        ? (JSON.parse(data.state) as SpreadsheetState)
        : data.state;
    }
    if (!state) return null;
    return { state, loadedUpdatedAt: data.updated_at };
  } catch {
    return null;
  }
}

/**
 * Атомарно (CAS) сохраняет state в `state_compressed`, при этом колонка
 * `state` ставится NULL (как делает frontend через backgroundSave).
 *
 * CAS: UPDATE применяется ТОЛЬКО если строка не изменилась с момента
 * load'а (`WHERE updated_at = loadedUpdatedAt`). Если кто-то параллельно
 * успел write — возвращаем `{ ok: false, reason: 'conflict' }`,
 * caller решает retry'ить или скипнуть.
 *
 * НЕ создаёт строку если её нет (no INSERT-on-conflict). Apply-сценарий
 * подразумевает что юзер УЖЕ работал со спредшитом (запустил job из него),
 * row точно существует. Если нет — это edge-case (внешний триггер job'а
 * без UI), return ok:false с reason='not_found'.
 */
export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'conflict' | 'not_found' | 'error'; details?: string };

export async function saveCompressedStateWithCas(
  userId: string,
  state: SpreadsheetState,
  loadedUpdatedAt: string,
): Promise<SaveResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'error', details: 'admin not configured' };

  let compressedB64: string;
  try {
    const json = JSON.stringify(state);
    const buf = await gzipP(Buffer.from(json, 'utf-8'));
    compressedB64 = buf.toString('base64');
  } catch (err) {
    return { ok: false, reason: 'error', details: `compress failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const newUpdatedAt = new Date().toISOString();
  try {
    const { data, error } = await supabaseAdmin
      .from('database_spreadsheet_states')
      .update({
        state: null,
        state_compressed: compressedB64,
        updated_at: newUpdatedAt,
      })
      .eq('user_id', userId)
      .eq('updated_at', loadedUpdatedAt)
      .select('user_id'); // .select() возвращает массив изменённых строк → видим затронуло ли

    if (error) return { ok: false, reason: 'error', details: error.message };
    if (!data || data.length === 0) {
      // CAS conflict ИЛИ строки не было. Различаем — проверим есть ли строка
      // у юзера вообще.
      const { data: existing } = await supabaseAdmin
        .from('database_spreadsheet_states')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle();
      return existing
        ? { ok: false, reason: 'conflict' }
        : { ok: false, reason: 'not_found' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', details: err instanceof Error ? err.message : String(err) };
  }
}
