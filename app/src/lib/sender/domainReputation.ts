/**
 * Репутация домена отправки во вкладке «Статистика» «Рассылки».
 *
 * Куда легло письмо у получателя — «Входящие» или «Спам» — отправитель не
 * узнаёт никогда: сервер получателя отвечает «принято» в обоих случаях.
 * Поэтому оценка собирается из того, что видно с нашей стороны:
 *   * DNS домена: подписи SPF / DKIM / DMARC и чёрные списки (проверяет
 *     domainHealth.ts на sender-воркере, результат — sender_domain_health);
 *   * отказы с боевых писем, разобранные по причине: «отклонили как спам»
 *     прямо говорит о репутации, «адреса нет» — о базе;
 *   * молчание: домен шлёт ту же базу, что и остальные, а ответов ноль там,
 *     где по среднему их должно было прийти несколько.
 *
 * Файл без server-only: те же правила раскрашивают таблицу на экране.
 */

/** Причины отказа — разбор sender_bounce_category (миграция 20261002_0020). */
export type BounceKind = 'spam' | 'auth' | 'no_user' | 'full' | 'temporary' | 'other';

export type BounceKinds = Partial<Record<BounceKind, number>>;

export type SpfStatus = 'ok' | 'soft' | 'missing' | 'multiple';
export type DmarcStatus = 'reject' | 'quarantine' | 'none' | 'missing';
/** listed — домен в списке; unknown — список не ответил или отказал в запросе. */
export type BlacklistStatus = 'listed' | 'clean' | 'unknown';

export interface DomainHealth {
  domain: string;
  checked_at: string;
  spf: SpfStatus | null;
  dmarc: DmarcStatus | null;
  /** Селектор найденного DKIM-ключа; null — ни под одним из обычных имён. */
  dkim_selector: string | null;
  blacklists: Record<string, BlacklistStatus>;
  error: string | null;
}

export type ReputationGrade = 'good' | 'warn' | 'bad' | 'unknown';

export interface ReputationInput {
  health: DomainHealth | null;
  /** Получателей, до которых дошло первое письмо (когорта периода). */
  reached: number;
  replied: number;
  bounceKinds: BounceKinds;
  /** Доля ответов у остальных доменов того же периода, 0…1; null — не с чем сравнить. */
  othersReplyRate: number | null;
}

export interface Reputation {
  grade: ReputationGrade;
  /** Что не так — короткими фразами, для подсказки у оценки. */
  issues: string[];
  /** Ответов, которых ждали по среднему остальных доменов; null — не считали. */
  expectedReplies: number | null;
  silent: boolean;
}

/**
 * Молчание считаем подозрительным, когда по среднему ждали хотя бы трёх
 * ответов: шанс случайно не получить ни одного — около 5%. Меньше — шум.
 */
export const SILENT_EXPECTED_REPLIES = 3;
/** Блокировок как спам: с какой доли получателей домен считаем плохим. */
const SPAM_BLOCK_BAD_RATE = 0.03;
const SPAM_BLOCK_BAD_MIN = 2;

export const BLACKLIST_LABELS: Record<string, string> = {
  spamhaus: 'Spamhaus',
  surbl: 'SURBL',
  uribl: 'URIBL',
};

/** Списки, попадание в которые — «есть риски», а не «плохая». */
const SOFT_BLACKLISTS = new Set(['surbl']);

export function evaluateDomainReputation(input: ReputationInput): Reputation {
  const { health, reached, replied, bounceKinds, othersReplyRate } = input;
  const bad: string[] = [];
  const warn: string[] = [];

  if (health) {
    const listed = Object.entries(health.blacklists)
      .filter(([, status]) => status === 'listed')
      .map(([list]) => list);
    // SURBL — риск, а не приговор: он проверяет ссылки и адреса в тексте
    // письма, Gmail его не смотрит. На 04.10.2026 в нём оказалась половина
    // наших доменов, включая те, с которых «Рассылка» не отправила ни письма, —
    // «плохая» по одному SURBL прятала домены с настоящими проблемами.
    const hard = listed.filter((list) => !SOFT_BLACKLISTS.has(list));
    const soft = listed.filter((list) => SOFT_BLACKLISTS.has(list));
    const label = (lists: string[]) => lists.map((list) => BLACKLIST_LABELS[list] ?? list).join(', ');
    if (hard.length) bad.push(`в чёрном списке: ${label(hard)}`);
    if (soft.length) warn.push(`в чёрном списке ${label(soft)} — опасно для ссылок и адресов в тексте письма`);
    if (health.spf === 'missing') bad.push('нет SPF — почтовики не знают, кому разрешено слать от домена');
    if (health.spf === 'multiple') bad.push('две записи SPF — почтовики считают это ошибкой');
    if (health.dmarc === 'missing') warn.push('нет DMARC');
    if (!health.dkim_selector) warn.push('DKIM не нашли под обычными именами — проверьте подпись у провайдера');
  }

  const spam = bounceKinds.spam ?? 0;
  if (spam >= SPAM_BLOCK_BAD_MIN && reached > 0 && spam / reached >= SPAM_BLOCK_BAD_RATE) {
    bad.push(`отклонили как спам: ${spam}`);
  } else if (spam > 0) {
    warn.push(`отклонили как спам: ${spam}`);
  }
  const auth = bounceKinds.auth ?? 0;
  if (auth > 0) warn.push(`не прошли проверку подписи домена: ${auth}`);

  const expectedReplies = othersReplyRate !== null && reached > 0 ? reached * othersReplyRate : null;
  const silent = replied === 0 && expectedReplies !== null && expectedReplies >= SILENT_EXPECTED_REPLIES;
  if (silent) {
    warn.push(`ни одного ответа, хотя по другим доменам ждали около ${Math.round(expectedReplies)} — возможно, письма в спаме`);
  }

  const issues = [...bad, ...warn];
  let grade: ReputationGrade;
  if (bad.length) grade = 'bad';
  else if (warn.length) grade = 'warn';
  else if (health || reached > 0) grade = 'good';
  else grade = 'unknown';
  return { grade, issues, expectedReplies, silent };
}
