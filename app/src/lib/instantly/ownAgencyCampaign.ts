/**
 * Наши собственные email-кампании. Две формы названия:
 *  - «1. Polza_HH_…», «11. Polza_B2B_SaaS_…» — номер, точка, «Polza» в начале;
 *  - «ENagency SDR», «ENagency v2 dir ect_hyp_001_apollo_300 UK&IR» — «ENagency»
 *    в начале (английский аутрич), регистр не важен.
 *
 * Такие кампании:
 *  - сами привязываются к проекту студии «Polza» мимо границы периода
 *    (`autoMatchCampaignsToProjects`), чтобы их диалоги были видны в
 *    «Персонализированных ответах»;
 *  - НЕ проходят клиентский квалификатор (`leadQualificationWorker`): пометки
 *    «лид», уведомлений специалисту и сделок в AMO по ним из него нет. Их ответы
 *    квалифицирует и передаёт в AMO отдельный проход (`lib/ownReplyLeads`, с
 *    14.10.2026; включается на вкладке «Квалификация»). Ответы инструмент читает
 *    напрямую из Instantly.
 *
 * Модуль без зависимостей: его тянут и каталог кампаний, и квалификатор, и
 * экран ответов.
 */
const OWN_AGENCY_CAMPAIGN_RE = /^\s*(?:\d+\s*\.\s*polza|enagency\b)/i;

export function isOwnAgencyCampaign(campaignName: string | null | undefined): boolean {
  return OWN_AGENCY_CAMPAIGN_RE.test(campaignName ?? '');
}

/** Проект студии, к которому относятся наши кампании, — клиент «Polza». */
export function isOwnAgencyProjectClient(client: string | null | undefined): boolean {
  return (client ?? '').trim().toLowerCase() === 'polza';
}
