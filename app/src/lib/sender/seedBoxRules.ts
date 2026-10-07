/**
 * Правила контрольных ящиков «Рассылки» без сети и базы: какие сервисы, как
 * узнать сервис по адресу, как разобрать строки продавца, какая папка — спам,
 * какой ящик взять по очереди и как считать health score. Модуль общий для
 * воркера, роутов и экрана.
 */

export type SeedProvider = 'yandex' | 'gmail' | 'mailru';

export const SEED_PROVIDERS: Record<SeedProvider, { label: string; imapHost: string; domains: string[] }> = {
  yandex: { label: 'Яндекс', imapHost: 'imap.yandex.ru', domains: ['yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'narod.ru'] },
  gmail: { label: 'Gmail', imapHost: 'imap.gmail.com', domains: ['gmail.com', 'googlemail.com'] },
  mailru: { label: 'Mail.ru', imapHost: 'imap.mail.ru', domains: ['mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru', 'mail.ua'] },
};

export function isSeedProvider(value: unknown): value is SeedProvider {
  return value === 'yandex' || value === 'gmail' || value === 'mailru';
}

/** Сервис по домену адреса; чужой домен — null (его выбирают руками). */
export function providerForEmail(email: string): SeedProvider | null {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  for (const [provider, info] of Object.entries(SEED_PROVIDERS) as [SeedProvider, (typeof SEED_PROVIDERS)[SeedProvider]][]) {
    if (info.domains.includes(domain)) return provider;
  }
  return null;
}

const EMAIL_RE = /^[^\s@:;]+@[^\s@:;]+\.[^\s@:;]+$/;

/**
 * Строка из выдачи продавца → адрес и пароль для IMAP. Форматы у продавцов
 * разные, но пароль для почтовых программ у всех последним полем:
 *   Mail.ru  логин:пароль:имя:фамилия:пол:дата рождения:пароль IMAP
 *   Яндекс   login;password(IMAP password)
 *   Gmail    Login:Password:2FA:App Password
 * Остальные поля (основной пароль, ключ 2FA) не храним вовсе.
 */
export function parseSeedLine(line: string): { email: string; password: string } | null {
  const fields = line.trim().split(/[:;]/).map((f) => f.trim()).filter(Boolean);
  if (fields.length < 2) return null;
  const email = fields[0].toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  const password = fields[fields.length - 1];
  return password ? { email, password } : null;
}

const JUNK_NAMES = ['spam', 'спам', 'junk', 'junk e-mail', '[gmail]/spam', '[gmail]/спам', 'нежелательная почта', 'bulk mail'];

/** Папка спама: сначала по отметке \Junk, затем по известным именам. */
export function pickJunkFolder(folders: Array<{ path: string; name: string; specialUse: string | null }>): string | null {
  const flagged = folders.find((f) => (f.specialUse ?? '').toLowerCase() === '\\junk');
  if (flagged) return flagged.path;
  const byName = folders.find((f) => JUNK_NAMES.includes(f.path.toLowerCase()) || JUNK_NAMES.includes(f.name.toLowerCase()));
  return byName?.path ?? null;
}

/**
 * Контрольный ящик по очереди: меньше всего проб за 7 дней; при равенстве —
 * не тот, что был у этого ящика рассылки в прошлый раз; дальше — случайно.
 */
export function pickSeedBox(
  candidates: Array<{ id: string; load: number }>,
  previousId: string | null,
  random: () => number = Math.random,
): string | null {
  if (!candidates.length) return null;
  const min = Math.min(...candidates.map((c) => c.load));
  const least = candidates.filter((c) => c.load === min);
  const fresh = least.filter((c) => c.id !== previousId);
  const pool = fresh.length ? fresh : least;
  return pool[Math.floor(random() * pool.length)].id;
}

/** Health score: доля «Входящих» среди доставленных и потерянных проб; null — данных нет. */
export function seedHealthScore(counts: { inbox: number; spam: number; missing: number }): number | null {
  const total = counts.inbox + counts.spam + counts.missing;
  return total ? Math.round((counts.inbox / total) * 100) : null;
}
