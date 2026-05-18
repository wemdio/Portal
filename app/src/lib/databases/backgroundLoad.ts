// Worker читает состояние в фоне, чтобы парсинг большого JSON не блокировал
// UI. Приоритет — сжатая колонка state_compressed (gzip+base64); если её
// нет (старая запись) — fallback на несжатый jsonb state.
// atob / DecompressionStream / Blob / Response доступны в Worker-контексте.
// hadStored сообщает наверх: в БД РЕАЛЬНО лежали данные. Если данные были,
// но извлечь валидный state не удалось — портал НЕ должен применять пустое
// состояние (иначе автосейв затрёт большой state в БД).
const WORKER_CODE = `
self.onmessage = async (e) => {
  const { url, headers } = e.data;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      self.postMessage({ ok: false, error: 'HTTP ' + res.status, hadStored: false });
      return;
    }
    const rows = await res.json();
    const row = rows && rows.length > 0 ? rows[0] : null;
    if (!row) {
      self.postMessage({ ok: true, state: null, hadStored: false });
      return;
    }
    const hadStored = !!(row.state_compressed || row.state);
    if (row.state_compressed) {
      try {
        const binary = atob(row.state_compressed);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const json = await new Response(stream).text();
        self.postMessage({ ok: true, state: JSON.parse(json), hadStored: true });
      } catch (err) {
        self.postMessage({ ok: false, error: 'decompress: ' + String(err), hadStored: true });
      }
      return;
    }
    self.postMessage({ ok: true, state: row.state ? row.state : null, hadStored: hadStored });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err), hadStored: false });
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
  | { ok: true; state: unknown | null; hadStored: boolean }
  | { ok: false; reason: 'timeout' | 'error'; hadStored: boolean };

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
    return Promise.resolve({ ok: false, reason: 'error', hadStored: false });
  }

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
    } catch {
      resolve({ ok: false, reason: 'error', hadStored: false });
      return;
    }

    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, reason: 'timeout', hadStored: false });
    }, LOAD_TIMEOUT_MS);

    worker.onmessage = (
      e: MessageEvent<{ ok: boolean; state?: unknown; error?: string; hadStored?: boolean }>,
    ) => {
      clearTimeout(timeout);
      worker.terminate();
      const hadStored = e.data.hadStored ?? false;
      if (e.data.ok) {
        resolve({ ok: true, state: e.data.state ?? null, hadStored });
      } else {
        resolve({ ok: false, reason: 'error', hadStored });
      }
    };

    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      resolve({ ok: false, reason: 'error', hadStored: false });
    };

    const url =
      `${supabaseUrl}/rest/v1/database_spreadsheet_states` +
      `?select=state_compressed,state&user_id=eq.${userId}&limit=1`;

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
