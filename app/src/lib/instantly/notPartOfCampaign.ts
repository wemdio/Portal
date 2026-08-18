/**
 * Провайдер отказывается отвечать на письмо, не принадлежащее кампании.
 *
 * POST /emails/reply и /emails/forward отвечают 400:
 *   The email you are replying to is not part of an Instantly campaign, so you
 *   cannot reply to it (missing campaign_id or list_id)
 *
 * Проверяется САМО письмо, а не запрос, поэтому передать campaign_id/list_id в
 * теле бесполезно, и у уже полученного письма их не изменить. Известно с
 * 27.07.2026 (Others-письма в handoff), подтверждено повторно 18.08.2026 на
 * «сиротах» кабинета.
 *
 * Обход один: отправить НОВОЕ письмо тем же ящиком через sendTestEmail
 * (compose-эндпоинта в v2 нет). Плата — письмо не заводит сущность в Unibox
 * провайдера и не поддерживает cc (копию кладём в to_address_email_list).
 *
 * Предикат вынесен в общий модуль намеренно: сравнение с текстом чужой ошибки
 * хрупкое, и жить оно должно в одном месте, а не копией в каждом вызывающем.
 * Матчим и по «not part of an … campaign», и по «missing campaign_id or
 * list_id» — если провайдер перепишет одну половину фразы, вторая удержит.
 * Имя вендора внутри НЕ требуем: в клиентском контуре его вычищает scrubBrand.
 */
export function isNotPartOfCampaignError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    /not part of an?\b.*\bcampaign/i.test(message) ||
    /missing campaign_id or list_id/i.test(message)
  );
}
