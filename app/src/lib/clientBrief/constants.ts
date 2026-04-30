import type {
  ClientBriefFields,
  ClientBriefPriceTier,
  ClientBriefSocialProofKey,
} from './types';

export const SOCIAL_PROOF_KEYS: readonly ClientBriefSocialProofKey[] = [
  'ratings',
  'media',
  'photos',
  'recommendations',
  'cases',
  'awards',
  'press',
  'presentations',
] as const;

export const SOCIAL_PROOF_LABELS: Record<ClientBriefSocialProofKey, string> = {
  ratings: 'Рейтинги и отзывы',
  media: 'Видео / подкасты / выступления',
  photos: 'Фотографии / картинки',
  recommendations: 'Рекомендации',
  cases: 'Успешные кейсы',
  awards: 'Награды / сертификаты',
  press: 'Упоминания в СМИ',
  presentations: 'Презентации компании / услуги / товара',
};

export const PRICE_TIER_LABELS: Record<ClientBriefPriceTier, string> = {
  economy: 'Эконом-класс',
  middle: 'Средний класс',
  business: 'Бизнес-класс',
  premium: 'Предмет роскоши',
};

export const ALLOWED_PRICE_TIERS: readonly ClientBriefPriceTier[] = [
  'economy',
  'middle',
  'business',
  'premium',
] as const;

/** Защита от мегабайтных вставок (несжатый JSON в БД). */
export const CLIENT_BRIEF_MAX_TOTAL_CHARS = 200_000;

/** Полностью пустой бриф — стартовое состояние формы и fallback. */
export const EMPTY_BRIEF_FIELDS: ClientBriefFields = {
  company_website: '',
  company_description: '',
  company_contacts: '',
  deal_cycle: '',
  avg_check: '',

  product_description: '',
  price_tier: null,
  advantages: '',
  usp: '',
  competitors_problems: '',
  impressive_numbers: '',
  special_offer: '',

  target_audience: '',
  client_problems: '',
  common_questions: '',

  persona_name: '',
  persona_position: '',
  lead_recipient_name: '',
  lead_recipient_email: '',
  lead_recipient_position: '',
  lead_magnets: '',
  guarantees: '',

  existing_clients: '',
  impressive_results: '',

  social_proof: SOCIAL_PROOF_KEYS.reduce(
    (acc, key) => {
      acc[key] = { has: false, comment: '' };
      return acc;
    },
    {} as ClientBriefFields['social_proof'],
  ),

  additional_notes: '',
};
