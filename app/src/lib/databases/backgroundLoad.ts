const WORKER_CODE = `
self.onmessage = async (e) => {
  const { url, headers } = e.data;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      self.postMessage({ ok: false, error: 'HTTP ' + res.status });
      return;
    }
    const rows = await res.json();
    const state = rows && rows.length > 0 && rows[0].state ? rows[0].state : null;
    self.postMessage({ ok: true, state });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
`;

/**
 * Результат чтения состояния. Критично различать «прочитали, в БД пусто»
 * (ok: true, state: null — это реально новый пользователь) и «не смогли
 * прочитать» (ok: false — таймаут/ошибка).
 *
 * Если их не различать (раньше оба возвращали просто null), портал при
 * неудачном чтении считал, что состояния нет, создавал пустую вкладку и
 * затем автосохранением ЗАТИРАЛ реально существующий большой state в БД.
 * Именно так терялись большие базы (~32k строк): их state ~30 МБ читался
 * 47-60 секунд, не укладываясь в прежний таймаут 30 секунд.
 */
export type LoadStateResult =
  | { ok: true; state: unknown | null }
  | { ok: false; reason: 'timeout' | 'error' };

// 30 секунд не хватало на чтение крупного state (30 МБ читаются ~минуту).
// 3 минуты — с запасом. Настоящее решение — сжатие state, но до него
// таймаут должен покрывать реальное время чтения, иначе данные теряются.
const LOAD_TIMEOUT_MS = 180_000;

export function loadStateViaWorker(
  userId: string,
  accessToken: string,
): Promise<LoadStateResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return Promise.resolve({ ok: false, reason: 'error' });
  }

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
    } catch {
      resolve({ ok: false, reason: 'error' });
      return;
    }

    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, reason: 'timeout' });
    }, LOAD_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<{ ok: boolean; state?: unknown; error?: string }>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (e.data.ok) {
        resolve({ ok: true, state: e.data.state ?? null });
      } else {
        resolve({ ok: false, reason: 'error' });
      }
    };

    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      resolve({ ok: false, reason: 'error' });
    };

    const url =
      `${supabaseUrl}/rest/v1/database_spreadsheet_states` +
      `?select=state&user_id=eq.${userId}&limit=1`;

    worker.postMessage({
      url,
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
  });
}
