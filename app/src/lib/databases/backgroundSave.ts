type SpreadsheetState = {
  version: number;
  tabs: Array<{ id: string; name: string; data: string[][] }>;
  activeTabId: string;
  tabCounter: number;
  columnWidths?: number[];
};

import { compressStateToBase64 } from './stateCompression';

const CHUNK_ROWS = 2000;

let saveGeneration = 0;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function serializeStateChunked(
  state: SpreadsheetState,
  generation: number,
): Promise<string | null> {
  const tabParts: string[] = [];

  for (const tab of state.tabs) {
    const rowChunks: string[] = [];

    for (let i = 0; i < tab.data.length; i += CHUNK_ROWS) {
      if (saveGeneration !== generation) return null;

      const end = Math.min(i + CHUNK_ROWS, tab.data.length);
      const chunk = tab.data.slice(i, end);
      rowChunks.push(chunk.map((row) => JSON.stringify(row)).join(','));

      if (end < tab.data.length) {
        await yieldToMain();
      }
    }

    const tabJson =
      `{"id":${JSON.stringify(tab.id)},"name":${JSON.stringify(tab.name)},"data":[${rowChunks.join(',')}]}`;
    tabParts.push(tabJson);
  }

  if (saveGeneration !== generation) return null;

  const cwJson = state.columnWidths ? `,"columnWidths":${JSON.stringify(state.columnWidths)}` : '';
  return (
    `{"version":${state.version},"tabs":[${tabParts.join(',')}]` +
    `,"activeTabId":${JSON.stringify(state.activeTabId)},"tabCounter":${state.tabCounter}${cwJson}}`
  );
}

export async function backgroundSave(
  payload: { user_id: string; state: SpreadsheetState; updated_at: string },
  accessToken: string,
  onError?: (msg: string) => void,
): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !accessToken) return false;

  const generation = ++saveGeneration;

  const stateJson = await serializeStateChunked(payload.state, generation);
  if (!stateJson) return false;

  // Сжимаем перед отправкой: 30 МБ JSON → ~4-5 МБ base64. Без этого
  // запись висела десятками секунд и большие базы терялись.
  let compressed: string;
  try {
    compressed = await compressStateToBase64(stateJson);
  } catch (err) {
    onError?.(`compress failed: ${String(err)}`);
    return false;
  }
  // Ещё одна проверка поколения — сжатие могло идти заметное время.
  if (saveGeneration !== generation) return false;

  // state шлём null: данные теперь в state_compressed, дублировать
  // несжатый jsonb незачем (он же — лишние мегабайты в строке).
  const body = JSON.stringify({
    user_id: payload.user_id,
    state: null,
    state_compressed: compressed,
    updated_at: payload.updated_at,
  });

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/database_spreadsheet_states`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${accessToken}`,
      },
      body,
    });
    if (!res.ok && onError) {
      onError(`HTTP ${res.status}`);
    }
    return res.ok;
  } catch (err) {
    onError?.(String(err));
    return false;
  }
}

export function cancelBackgroundSave(): void {
  saveGeneration++;
}
