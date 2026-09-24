// Какие письма папки Others не показывать во вкладке Others: роботов и наши же
// ящики. Правила — как у сторожа Others (lib/instantly/othersWatchdog.ts,
// screenOthersEmail), но код свой: инструмент намеренно не импортирует контур
// квалификатора (спецификация от 12.09.2026, раздел 3).
//
// Чужой прогрев и спам НЕ отсекаем: надёжного признака у них нет, а спрятать
// живой ответ хуже, чем показать лишнее письмо.

import { datasetQuery, isDatasetConfigured } from '@/lib/instantlyDataset';
import type { Email } from '@/lib/instantly/types';

// Только явно машинные адреса. Человеческие групповые ящики (sales@, info@) не
// трогаем: с них отвечают живые люди.
const ROBOT_LOCAL_RE =
  /^(?:no[-_.]?reply|postmaster|mailer-daemon|mailsystem|adminreport|dmarc[a-z0-9._-]*|bounce[a-z0-9._-]*|abuse|daemon|robot\d*)$/;
// DMARC-отчёты о нашем домене: «Report Domain: <домен>».
const DMARC_SUBJECT_RE = /report domain:/i;

/** true — письмо от робота или от нашего же ящика: во вкладке его не показываем. */
export function isRobotLetter(email: Email, ourDomains: ReadonlySet<string>): boolean {
  const sender = (email.from_address_email ?? '').trim().toLowerCase();
  if (!email.id || !sender.includes('@')) return true;
  if ((email.ue_type ?? 2) !== 2) return true;
  const [localPart = '', domain = ''] = sender.split('@');
  if (ourDomains.has(domain)) return true;
  if (ROBOT_LOCAL_RE.test(localPart)) return true;
  return DMARC_SUBJECT_RE.test(email.subject ?? '');
}

const DOMAINS_TTL_MS = 12 * 60 * 60 * 1000;
let domainsCache: { domains: Set<string>; expiresAt: number } | null = null;

/**
 * Домены всех наших ящиков основного аккаунта Instantly — из аналитического
 * датасета (ночной синк raw_accounts): живой /accounts на холодном старте —
 * около 11 страниц, а свежесть до суток для доменов не важна. Датасет
 * недоступен — пустое множество: фильтр опирается на домены ящиков проекта.
 */
export async function loadOurSendingDomains(): Promise<Set<string>> {
  if (domainsCache && domainsCache.expiresAt > Date.now()) return domainsCache.domains;
  if (!isDatasetConfigured()) return new Set();
  try {
    const rows = await datasetQuery<{ domain: string }>(
      `SELECT DISTINCT lower(split_part(email, '@', 2)) AS domain
       FROM raw_accounts
       WHERE email LIKE '%@%'`,
    );
    const domains = new Set(rows.map((row) => row.domain).filter(Boolean));
    if (domains.size > 0) domainsCache = { domains, expiresAt: Date.now() + DOMAINS_TTL_MS };
    return domains;
  } catch {
    return new Set();
  }
}
