/**
 * Наши собственные email-кампании Polza: «1. Polza_HH_…», «11. Polza_B2B_SaaS_…».
 *
 * Номер, точка, «Polza» в начале названия. Такие кампании:
 *  - сами привязываются к проекту студии «Polza» мимо границы периода
 *    (`autoMatchCampaignsToProjects`), чтобы их диалоги были видны в
 *    «Персонализированных ответах»;
 *  - НЕ проходят квалификатор: пометки «лид», уведомлений специалисту и сделок
 *    в AMO по ним нет — с 06.10.2026 сделки по ним продажи заводят руками.
 *    Ответы инструмент читает напрямую из Instantly.
 *
 * Модуль без зависимостей: его тянут и каталог кампаний, и квалификатор, и
 * экран ответов.
 */
const OWN_AGENCY_CAMPAIGN_RE = /^\s*\d+\s*\.\s*polza/i;

export function isOwnAgencyCampaign(campaignName: string | null | undefined): boolean {
  return OWN_AGENCY_CAMPAIGN_RE.test(campaignName ?? '');
}

/** Проект студии, к которому относятся наши кампании, — клиент «Polza». */
export function isOwnAgencyProjectClient(client: string | null | undefined): boolean {
  return (client ?? '').trim().toLowerCase() === 'polza';
}
