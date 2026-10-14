/**
 * Живые процессы OutreachOS в контейнере — для сторожа и страховки крона.
 *
 * Прогон и сторож запускаются `docker exec` в portal-worker-hh, поэтому их
 * видно в /proc того же контейнера. Строка `running` без процесса — труп
 * прогона, убитого вместе с контейнером (инцидент 23–24.09.2026).
 */

import 'server-only';
import { readdirSync, readFileSync } from 'node:fs';

/** cmdline прогона: `node /app/workers/outreachosCron.js [--resume=…|--anchor=…]`. */
export const PIPELINE_PROCESS_MARKER = 'outreachosCron.js';
/** cmdline сторожа. Маркер прогона в нём не встречается. */
export const WATCHDOG_PROCESS_MARKER = 'outreachosWatchdogCron.js';

/**
 * Есть ли в контейнере другой процесс с одним из маркеров в cmdline (свой pid
 * не считается). FAIL-SAFE: /proc не читается — возвращаем true, то есть
 * «жив». Ошибиться в эту сторону дёшево (пропустим тик сторожа), в обратную —
 * дорого (закроем или задвоим живой прогон).
 */
export function hasLiveOutreachOsProcess(markers: string[], log: (msg: string) => void): boolean {
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch (err) {
    log(`/proc недоступен (${err instanceof Error ? err.message : String(err)}) — считаем процесс живым`);
    return true;
  }
  const selfPid = String(process.pid);
  for (const pid of pids) {
    if (pid === selfPid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue; // процесс успел завершиться или недоступен — не наш случай
    }
    if (markers.some((marker) => cmdline.includes(marker))) return true;
  }
  return false;
}
