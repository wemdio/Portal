'use server';

import { runCollection } from '@/app/api/tools/bugor-outreach/collect/route';
import { isStaffServerAction } from '@/lib/auth/serverActionStaff';

/** Invokes the Bugor Outreach collect pipeline directly on the server. */
export async function triggerBugorCollect(): Promise<{ ok: boolean; error?: string }> {
  // Сбор платный — запускает только сотрудник (аудит 26.10.2026).
  if (!(await isStaffServerAction())) return { ok: false, error: 'Доступ только для сотрудников' };
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
