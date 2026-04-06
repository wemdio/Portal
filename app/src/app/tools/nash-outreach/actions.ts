'use server';

import { runCollection } from '@/app/api/tools/nash-outreach/collect/route';

/** Invokes the Nash Outreach collect pipeline directly on the server. */
export async function triggerNashCollect(): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await runCollection();
    const data = await response.json();
    if (data.ok === false) {
      console.error('[triggerNashCollect] pipeline returned errors:', data.errors);
      return { ok: false, error: 'Произошла ошибка при сборе лидов' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[triggerNashCollect] unexpected error:', err);
    return { ok: false, error: 'Произошла ошибка сервера' };
  }
}
