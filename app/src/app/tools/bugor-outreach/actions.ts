'use server';

import { runCollection } from '@/app/api/tools/bugor-outreach/collect/route';

/** Invokes the Bugor Outreach collect pipeline directly on the server. */
export async function triggerBugorCollect(): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await runCollection();
    const data = await response.json();
    if (data.ok === false) {
      console.error('[triggerBugorCollect] pipeline returned errors:', data.errors);
      return { ok: false, error: 'Произошла ошибка при сборе лидов' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[triggerBugorCollect] unexpected error:', err);
    return { ok: false, error: 'Произошла ошибка сервера' };
  }
}
