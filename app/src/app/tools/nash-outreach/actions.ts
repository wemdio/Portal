'use server';

import { runCollection } from '@/app/api/tools/nash-outreach/collect/route';
import { isStaffServerAction } from '@/lib/auth/serverActionStaff';

/** Invokes the Nash Outreach collect pipeline directly on the server. */
export async function triggerNashCollect(): Promise<{ ok: boolean; error?: string }> {
  // Сбор платный — запускает только сотрудник (аудит 26.10.2026).
  if (!(await isStaffServerAction())) return { ok: false, error: 'Доступ только для сотрудников' };
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
