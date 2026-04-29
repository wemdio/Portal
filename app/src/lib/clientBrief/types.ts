/**
 * Client brief — структурированный бриф клиента, заполняется в /client/brief
 * и используется AI-инструментами для лучших результатов (Оценка ЦА, гипотезы и пр.).
 *
 * Поля собраны из реального шаблона агентства (см. шаблон Polza Outreach).
 * Все поля опциональные — клиент может сохранять как черновик.
 */

export type ClientBriefPriceTier = 'economy' | 'middle' | 'business' | 'premium';

export interface ClientBriefSocialProof {
  has: boolean;
  comment: string;
}

export type ClientBriefSocialProofKey =
  | 'ratings'
  | 'media'
  | 'photos'
  | 'recommendations'
  | 'cases'
  | 'awards'
  | 'press'
  | 'presentations';

export interface ClientBriefFields {
  // 1. Компания
  company_website: string;
  company_description: string;
  company_contacts: string;
  deal_cycle: string;
  avg_check: string;

  // 2. Продукт / услуга
  product_description: string;
  price_tier: ClientBriefPriceTier | null;
  advantages: string;
  usp: string;
  competitors_problems: string;
  impressive_numbers: string;
  special_offer: string;

  // 3. Целевая аудитория
  target_audience: string;
  client_problems: string;
  common_questions: string;

  // 4. Коммуникация
  persona_name: string;
  persona_position: string;
  lead_recipient_name: string;
  lead_recipient_email: string;
  lead_recipient_position: string;
  lead_magnets: string;
  guarantees: string;

  // 5. Доказательства
  existing_clients: string;
  impressive_results: string;

  // 6. Social proof
  social_proof: Record<ClientBriefSocialProofKey, ClientBriefSocialProof>;

  // 7. Дополнительный контекст
  additional_notes: string;
}

export interface ClientBriefRecord {
  id: string;
  client_user_id: string;
  fields: ClientBriefFields;
  pdf_path: string | null;
  pdf_file_name: string | null;
  pdf_uploaded_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
