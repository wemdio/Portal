import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type EngTinyfishReservation = 'granted' | 'daily_exhausted' | 'unavailable';

/** Reserve before each HTTP attempt. Never refund a reservation, including on
 * timeout, cancellation or unknown response: the provider may have counted it.
 * Only a confirmed per-account daily refusal permits another pool account.
 * Missing migration, shared minute limits and uncertain outcomes fail closed.
 * Other users of the account outside this gate cannot be counted here. */
export async function reserveEngTinyfishUrl(accountId: string, signal?: AbortSignal): Promise<EngTinyfishReservation> {
  signal?.throwIfAborted();
  if (!supabaseAdmin || !/^[a-zA-Z0-9._-]{1,80}$/.test(accountId)) return 'unavailable';
  const controller = new AbortController();
  let finishOnAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => { finishOnAbort = () => resolve(null); });
  const abort = () => { controller.abort(); finishOnAbort?.(); };
  signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal?.throwIfAborted();
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 2500); });
    const result = await Promise.race([
      supabaseAdmin.rpc('eng_tinyfish_reserve_url', { p_account: accountId }).abortSignal(controller.signal), timeout, aborted,
    ]);
    signal?.throwIfAborted();
    if (!result || result.error || !result.data || typeof result.data !== 'object'
      || Array.isArray(result.data) || result.data.budget_version !== 2) return 'unavailable';
    if (result.data.granted === true && result.data.reason === undefined) return 'granted';
    return result.data.granted === false && result.data.reason === 'daily_exhausted'
      ? 'daily_exhausted' : 'unavailable';
  } catch {
    signal?.throwIfAborted();
    return 'unavailable';
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
