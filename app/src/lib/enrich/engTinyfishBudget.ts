import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/** Reserve before each HTTP attempt. Never refund a reservation, including on
 * timeout, cancellation or unknown response: the provider may have counted it.
 * Other users of the account outside this gate cannot be counted here. */
export async function reserveEngTinyfishUrl(accountId: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!supabaseAdmin || !/^[a-zA-Z0-9._-]{1,80}$/.test(accountId)) return false;
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
    return !!result && !result.error && result.data?.granted === true;
  } catch {
    signal?.throwIfAborted();
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
