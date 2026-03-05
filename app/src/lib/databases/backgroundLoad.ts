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

export function loadStateViaWorker(
  userId: string,
  accessToken: string,
): Promise<unknown | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return Promise.resolve(null);

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
    } catch {
      resolve(null);
      return;
    }

    const timeout = setTimeout(() => {
      worker.terminate();
      resolve(null);
    }, 30_000);

    worker.onmessage = (e: MessageEvent<{ ok: boolean; state?: unknown; error?: string }>) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(e.data.ok ? (e.data.state ?? null) : null);
    };

    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(null);
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
