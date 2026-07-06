import type { ClientBriefFields } from './types';

/**
 * Метаданные 7 разделов брифа для правого навигатора (кольцо прогресса +
 * карта разделов со скролл-спаем). id совпадает с DOM-якорем `brief-section-N`
 * на соответствующем <section> в ClientBriefForm.
 */
export interface BriefSectionMeta {
  /** Порядковый номер (совпадает с SectionHeader number). */
  num: number;
  /** DOM-id якоря для скролла/скролл-спая. */
  anchorId: string;
  title: string;
}

export const BRIEF_SECTIONS: readonly BriefSectionMeta[] = [
  { num: 1, anchorId: 'brief-section-1', title: 'О компании' },
  { num: 2, anchorId: 'brief-section-2', title: 'Продукт / услуга' },
  { num: 3, anchorId: 'brief-section-3', title: 'Целевая аудитория' },
  { num: 4, anchorId: 'brief-section-4', title: 'Коммуникация' },
  { num: 5, anchorId: 'brief-section-5', title: 'Доказательства' },
  { num: 6, anchorId: 'brief-section-6', title: 'Social proof' },
  { num: 7, anchorId: 'brief-section-7', title: 'Дополнительный контекст' },
] as const;

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** Раздел 6: заполнен, если по любому пункту отмечено «есть» или дан комментарий. */
function socialProofFilled(sp: ClientBriefFields['social_proof']): boolean {
  if (!sp || typeof sp !== 'object') return false;
  return Object.values(sp).some((item) => item?.has === true || nonEmpty(item?.comment));
}

/**
 * Заполнен ли раздел (по номеру) — «заполнен» = ХОТЯ БЫ ОДНО непустое поле
 * раздела (все поля брифа опциональны, поэтому считаем по принципу «есть что-то»).
 */
export function isBriefSectionFilled(num: number, f: ClientBriefFields): boolean {
  switch (num) {
    case 1:
      return (
        nonEmpty(f.company_website) ||
        nonEmpty(f.company_description) ||
        nonEmpty(f.company_contacts) ||
        nonEmpty(f.deal_cycle) ||
        nonEmpty(f.avg_check)
      );
    case 2:
      return (
        nonEmpty(f.product_description) ||
        f.price_tier != null ||
        nonEmpty(f.advantages) ||
        nonEmpty(f.usp) ||
        nonEmpty(f.competitors_problems) ||
        nonEmpty(f.impressive_numbers) ||
        nonEmpty(f.special_offer)
      );
    case 3:
      return nonEmpty(f.target_audience) || nonEmpty(f.client_problems) || nonEmpty(f.common_questions);
    case 4:
      return (
        nonEmpty(f.persona_name) ||
        nonEmpty(f.persona_position) ||
        nonEmpty(f.lead_recipient_name) ||
        nonEmpty(f.lead_recipient_email) ||
        nonEmpty(f.lead_recipient_position) ||
        nonEmpty(f.lead_magnets) ||
        nonEmpty(f.guarantees)
      );
    case 5:
      return nonEmpty(f.existing_clients) || nonEmpty(f.impressive_results);
    case 6:
      return socialProofFilled(f.social_proof);
    case 7:
      return nonEmpty(f.additional_notes);
    default:
      return false;
  }
}

/** Карта «номер раздела → заполнен ли». */
export function briefSectionsFilled(f: ClientBriefFields): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const s of BRIEF_SECTIONS) out[s.num] = isBriefSectionFilled(s.num, f);
  return out;
}

/** Сколько из 7 разделов заполнено. */
export function briefFilledCount(f: ClientBriefFields): number {
  return BRIEF_SECTIONS.reduce((n, s) => n + (isBriefSectionFilled(s.num, f) ? 1 : 0), 0);
}
