/**
 * Наши собственные email-кампании. Две формы названия:
 *  - «1. Polza_HH_…», «11. Polza_B2B_SaaS_…» — номер, точка, «Polza» в начале;
 *  - «ENagency SDR», «ENagency v2 dir ect_hyp_001_apollo_300 UK&IR» — «ENagency»
 *    в начале (английский аутрич), регистр не важен.
 *
 * Такие кампании:
 *  - сами привязываются к своему проекту студии мимо границы периода
 *    (`autoMatchCampaignsToProjects`): «N. Polza_…» — к клиенту «Polza»,
 *    «ENagency …» — к клиенту «ENagency», и никогда крест-накрест; так их
 *    диалоги видны в «Персонализированных ответах»;
 *  - НЕ проходят клиентский квалификатор (`leadQualificationWorker`): пометки
 *    «лид», уведомлений специалисту и сделок в AMO по ним из него нет. Их ответы
 *    квалифицирует и передаёт в AMO отдельный проход (`lib/ownReplyLeads`, с
 *    14.10.2026; включается на вкладке «Квалификация»). Ответы инструмент читает
 *    напрямую из Instantly.
 *
 * Модуль без зависимостей: его тянут и каталог кампаний, и квалификатор, и
 * экран ответов.
 */
// «N. Polza_…»: номер, точка, «Polza» в начале названия.
const POLZA_CAMPAIGN_RE = /^\s*\d+\s*\.\s*polza/i;
// «ENagency …»: слово «ENagency» в начале названия.
const ENAGENCY_CAMPAIGN_RE = /^\s*enagency\b/i;

/** Английский аутрич студии: «ENagency …». Остальные наши кампании — русские «N. Polza_…». */
export function isEnAgencyCampaign(campaignName: string | null | undefined): boolean {
  return ENAGENCY_CAMPAIGN_RE.test(campaignName ?? '');
}

export function isOwnAgencyCampaign(campaignName: string | null | undefined): boolean {
  const name = campaignName ?? '';
  return POLZA_CAMPAIGN_RE.test(name) || ENAGENCY_CAMPAIGN_RE.test(name);
}

/**
 * Наша кампания принадлежит именно этому проекту студии: «N. Polza_…» — клиенту
 * «Polza», «ENagency …» — клиенту «ENagency». Крест-накрест — false.
 */
export function ownAgencyProjectMatches(
  projectClient: string | null | undefined,
  campaignName: string | null | undefined,
): boolean {
  const client = (projectClient ?? '').trim().toLowerCase();
  const name = campaignName ?? '';
  if (client === 'polza') return POLZA_CAMPAIGN_RE.test(name);
  if (client === 'enagency') return ENAGENCY_CAMPAIGN_RE.test(name);
  return false;
}
