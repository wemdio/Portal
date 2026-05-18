'use server';

import { runCollection } from '@/app/api/tools/event-outreach/collect/route';
import type { CollectResult, SelectFilters } from '@/lib/eventOutreach/types';

export interface TriggerResult {
  ok: boolean;
  error?: string;
  stats?: CollectResult;
}

/** Runs the event-outreach collection pipeline directly on the server. */
export async function triggerEventCollect(filters: SelectFilters): Promise<TriggerResult> {
  try {
    const response = await runCollection(filters);
    const data = (await response.json()) as CollectResult & { ok?: boolean; error?: string };
    if (data.ok === false) {
      console.error('[triggerEventCollect] pipeline errors:', data.errors);
      return { ok: false, error: data.error ?? 'Произошла ошибка при сборе базы', stats: data };
    }
    return { ok: true, stats: data };
  } catch (err) {
    console.error('[triggerEventCollect] unexpected error:', err);
    return { ok: false, error: 'Произошла ошибка сервера' };
  }
}
