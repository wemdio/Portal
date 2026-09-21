/**
 * Список кампаний в пикере «Привязать кампанию».
 *
 * Кампания принадлежит ровно одному проекту (claim_project_instantly_campaign),
 * и занятых в воркспейсе примерно 2 из 3. Пока пикер про это не знал, верх списка
 * был сплошь некликабельным: клик уходил в 409, фронт его молчал, и выглядело это
 * как «кнопка привязки не работает». Поэтому свободные поднимаются наверх, а занятые
 * остаются видимыми — с именем владельца, чтобы было понятно, где кампанию отвязать.
 *
 * Логика общая для карточки проекта в списке и для страницы /projects/[id].
 */

export type PickerCampaign = { id: string; name: string };

export type CampaignPickerEntry = {
  campaign: PickerCampaign;
  /** Название проекта-владельца, если кампания уже занята другим проектом. */
  takenBy: string | null;
};

export function buildCampaignPickerEntries(
  allCampaigns: PickerCampaign[],
  linkedCampaignIds: Iterable<string>,
  takenByProject: Record<string, string>,
  search: string,
  limit = 20,
): CampaignPickerEntry[] {
  const linked = new Set(linkedCampaignIds);
  const needle = search.trim().toLowerCase();

  const matched = allCampaigns.filter(
    (campaign) =>
      !linked.has(campaign.id) &&
      (!needle || campaign.name.toLowerCase().includes(needle)),
  );

  const free = matched.filter((campaign) => !takenByProject[campaign.id]);
  const taken = matched.filter((campaign) => takenByProject[campaign.id]);

  return [...free, ...taken]
    .slice(0, limit)
    .map((campaign) => ({ campaign, takenBy: takenByProject[campaign.id] ?? null }));
}
