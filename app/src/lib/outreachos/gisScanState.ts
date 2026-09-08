import 'server-only';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeTwoGisFilters } from '@/lib/twoGis/query';
import type { TwoGisRubricGroup } from '@/lib/twoGis/types';

type Logger = (message: string) => void;

export interface GisScanState {
  snapshot_id: number | null;
  rubric_key: string | null;
  after_id: string | null;
  revision: number;
}

export interface GisScanCheckpoint {
  previous: GisScanState;
  snapshotId: number;
  rubricKey: string;
  afterId: string | null;
}

/** Порядок рубрик не меняет выборку. Target/cap не должны сбрасывать обход. */
export function gisScanRubricKey(rubricGroups: TwoGisRubricGroup[]): string {
  const groups = normalizeTwoGisFilters({ rubricGroups }).rubricGroups ?? [];
  const canonical = groups.map((group) => JSON.stringify({
    category: group.category,
    mode: group.mode,
    values: group.mode === 'all' ? [] : [...(
      group.mode === 'some' ? group.subcategories : group.excludedSubcategories
    )].sort(),
  })).sort();
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Новый снапшот/набор рубрик → сначала. Ревизию сохраняем для CAS записи. */
export function gisScanStartCursor(
  state: GisScanState,
  snapshotId: number,
  rubricKey: string,
): string | undefined {
  return state.snapshot_id === snapshotId && state.rubric_key === rubricKey
    ? state.after_id ?? undefined
    : undefined;
}

/** Fail-closed для GIS: без доступного состояния не повторяем начало каждый день. */
export async function loadGisScanState(log: Logger): Promise<GisScanState | null> {
  try {
    if (!supabaseAdmin) throw new Error('supabaseAdmin unavailable');
    const { data, error } = await supabaseAdmin
      .from('outreachos_gis_scan_state')
      .select('snapshot_id, rubric_key, after_id, revision')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('singleton missing; apply the GIS scan state migration');
    const row = data as GisScanState;
    if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new Error('invalid scan state revision');
    }
    return row;
  } catch (error) {
    log(`[gis-scan] состояние недоступно: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Только после markSeen в live-режиме. CAS не позволяет старому прогону
 * перезаписать уже продвинутый курсор. Это не блокировка параллельных заливок.
 * Сбой сохранения не должен отменять append уже подготовленных контактов.
 */
export async function saveGisScanState(checkpoint: GisScanCheckpoint, log: Logger): Promise<boolean> {
  try {
    if (!supabaseAdmin) throw new Error('supabaseAdmin unavailable');
    const { data, error } = await supabaseAdmin
      .from('outreachos_gis_scan_state')
      .update({
        snapshot_id: checkpoint.snapshotId,
        rubric_key: checkpoint.rubricKey,
        after_id: checkpoint.afterId,
        revision: checkpoint.previous.revision + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1)
      .eq('revision', checkpoint.previous.revision)
      .select('id');
    if (error) throw new Error(error.message);
    if (data?.length !== 1) {
      log('[gis-scan] курсор уже изменён другим прогоном — устаревшая запись пропущена');
      return false;
    }
    log(`[gis-scan] позиция сохранена: ${checkpoint.afterId ?? 'начало следующего прохода'}`);
    return true;
  } catch (error) {
    log(`[gis-scan] не удалось сохранить позицию, заливка продолжается: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
