'use server';

import { headers } from 'next/headers';

/** Server-side proxy that triggers the Nash Outreach collect pipeline using CRON_SECRET. */
export async function triggerNashCollect(): Promise<{ ok: boolean; error?: string }> {
  try {
    const h = await headers();
    const host = h.get('host') ?? 'localhost:3000';
    const proto = h.get('x-forwarded-proto') ?? 'https';
    const secret = process.env.CRON_SECRET ?? '';

    const res = await fetch(`${proto}://${host}/api/tools/nash-outreach/collect`, {
      method: 'POST',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Ошибка ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json().catch(() => ({}));
    if (data.ok === false) {
      return { ok: false, error: data.errors?.[0] ?? 'Pipeline error' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
