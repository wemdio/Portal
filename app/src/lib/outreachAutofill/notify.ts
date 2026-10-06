import 'server-only';

import { escapeTelegramHtml, sendWorkerNotice } from '@/lib/telegram/workerAlert';
import { AUTOFILL_LABEL, type AutofillLang } from './settings';

/** Кого отмечать, когда автодобору нужен человек. */
const AUTOFILL_MENTION = '@kuladmedDm';

/**
 * Сообщение автодобора в чат техники (бот health-check). tag — нужен человек:
 * в конце отметка @kuladmedDm. Текст — обычный, экранируется здесь.
 */
export async function notifyAutofill(lang: AutofillLang, text: string, opts: { tag: boolean }): Promise<void> {
  const lines = [`<b>Автодобор ${AUTOFILL_LABEL[lang]}</b>: ${escapeTelegramHtml(text)}`];
  if (opts.tag) lines.push(AUTOFILL_MENTION);
  await sendWorkerNotice(lines.join('\n'));
}
