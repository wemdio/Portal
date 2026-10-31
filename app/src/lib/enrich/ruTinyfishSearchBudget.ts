import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/** One reservation per Search attempt, never refunded or retried on an
 * uncertain outcome. Search and Fetch use separate ledgers for the same
 * stable provider quota account. Missing migration/DB closes admission. */
export async function reserveRuTinyfishSearch(accountId: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!supabaseAdmin || typeof accountId !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(accountId)) return false;
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
      supabaseAdmin.rpc('ru_tinyfish_reserve_search', { p_account: accountId }).abortSignal(controller.signal), timeout, aborted,
    ]);
    signal?.throwIfAborted();
    return !!result && !result.error && !!result.data && typeof result.data === 'object'
      && !Array.isArray(result.data) && result.data.budget_version === 1
      && result.data.granted === true && result.data.reason === undefined;
  } catch {
    signal?.throwIfAborted();
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
