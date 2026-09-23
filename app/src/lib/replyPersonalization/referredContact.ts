// Новый контакт в ответе адресата: «по этому вопросу — к Екатерине,
// почта ...». Отвечать тогда нужно не тому, кто написал, а по новому адресу.
//
// Адреса ищем только в свежей части ответа, до цитаты нашего письма: там
// стоят наши же ящики и получатели первого письма («To: avia@...»), и они
// выдавались бы за новый контакт.

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Где начинается цитата: «>», «From:/От:», «-----Original/Пересылаемое»,
 * «... wrote:/написал:» и строки вида «Понедельник, 21 сентября 2026, 19:05 от
 * Nikita <...>», которыми почтовики открывают цитату.
 */
const QUOTE_START_RE = new RegExp(
  [
    '^\\s*>',
    '^\\s*(from|от|sent|отправлено|кому|to)\\s*:',
    '^\\s*-{2,}\\s*(original|forwarded|пересылаемое|исходное)',
    '(wrote|написал|написала|пишет)\\s*:\\s*$',
    '^.{0,80}\\d{4}.{0,40}\\s(от|from)\\s.+@',
  ].join('|'),
  'im',
);

export function freshPart(text: string): string {
  const match = QUOTE_START_RE.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/**
 * Адреса, на которые адресат перенаправил, — без его собственного адреса
 * (он часто стоит в подписи) и без наших ящиков.
 */
export function findReferredEmails(replyText: string, exclude: Array<string | null | undefined>): string[] {
  const excluded = new Set(exclude.filter(Boolean).map((e) => e!.toLowerCase()));
  const found = new Set<string>();
  for (const raw of freshPart(replyText).match(EMAIL_RE) ?? []) {
    const email = raw.toLowerCase().replace(/\.+$/, '');
    if (!excluded.has(email)) found.add(email);
  }
  return [...found];
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}
