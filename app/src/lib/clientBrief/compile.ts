import { PRICE_TIER_LABELS, SOCIAL_PROOF_KEYS, SOCIAL_PROOF_LABELS } from './constants';
import type { ClientBriefFields, ClientBriefSocialProofKey } from './types';

interface FieldEntry {
  label: string;
  value: string;
}

function pushField(out: FieldEntry[], label: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  out.push({ label, value: trimmed });
}

function renderSection(heading: string, fields: FieldEntry[]): string | null {
  if (fields.length === 0) return null;
  const lines = [`## ${heading}`];
  for (const { label, value } of fields) {
    if (value.includes('\n')) {
      lines.push(`**${label}**:`);
      lines.push(value);
    } else {
      lines.push(`**${label}**: ${value}`);
    }
  }
  return lines.join('\n');
}

function buildCompanySection(f: ClientBriefFields): string | null {
  const fields: FieldEntry[] = [];
  pushField(fields, 'Сайт', f.company_website);
  pushField(fields, 'Описание', f.company_description);
  pushField(fields, 'Контакты', f.company_contacts);
  pushField(fields, 'Цикл сделки', f.deal_cycle);
  pushField(fields, 'Средний чек', f.avg_check);
  return renderSection('Компания', fields);
}

function buildProductSection(f: ClientBriefFields): string | null {
  const fields: FieldEntry[] = [];
  pushField(fields, 'Описание', f.product_description);
  if (f.price_tier) {
    pushField(fields, 'Ценовая категория', PRICE_TIER_LABELS[f.price_tier]);
  }
  pushField(fields, 'Преимущества', f.advantages);
  pushField(fields, 'УТП', f.usp);
  pushField(fields, 'Проблемы у конкурентов', f.competitors_problems);
  pushField(fields, 'Внушительные цифры', f.impressive_numbers);
  pushField(fields, 'Акция / спец. предложение', f.special_offer);
  return renderSection('Продукт / услуга', fields);
}

function buildAudienceSection(f: ClientBriefFields): string | null {
  const fields: FieldEntry[] = [];
  pushField(fields, 'Описание ЦА', f.target_audience);
  pushField(fields, 'С какими проблемами приходят', f.client_problems);
  pushField(fields, 'Какие вопросы задают', f.common_questions);
  return renderSection('Целевая аудитория', fields);
}

function buildCommunicationSection(f: ClientBriefFields): string | null {
  const fields: FieldEntry[] = [];
  const persona = [f.persona_name, f.persona_position].filter(Boolean).join(', ');
  pushField(fields, 'От чьего лица ведём диалог', persona);
  const recipient = [f.lead_recipient_name, f.lead_recipient_email, f.lead_recipient_position]
    .filter(Boolean)
    .join(', ');
  pushField(fields, 'Получатель тёплых лидов', recipient);
  pushField(fields, 'Лид-магниты', f.lead_magnets);
  pushField(fields, 'Гарантии', f.guarantees);
  return renderSection('Коммуникация', fields);
}

function buildEvidenceSection(f: ClientBriefFields): string | null {
  const fields: FieldEntry[] = [];
  pushField(fields, 'Действующие клиенты', f.existing_clients);
  pushField(fields, 'Впечатляющие результаты', f.impressive_results);
  return renderSection('Доказательства', fields);
}

function buildSocialProofSection(f: ClientBriefFields): string | null {
  const items: string[] = [];
  for (const key of SOCIAL_PROOF_KEYS as readonly ClientBriefSocialProofKey[]) {
    const item = f.social_proof[key];
    if (!item.has) continue;
    const label = SOCIAL_PROOF_LABELS[key];
    const comment = item.comment.trim();
    items.push(comment ? `- ${label}: ${comment}` : `- ${label}`);
  }
  if (items.length === 0) return null;
  return ['## Social proof', ...items].join('\n');
}

function buildAdditionalSection(f: ClientBriefFields): string | null {
  if (!f.additional_notes.trim()) return null;
  return ['## Дополнительный контекст', f.additional_notes.trim()].join('\n');
}

/**
 * Склеивает структурированный бриф в плотный markdown для AI.
 * Пропускает целые секции, где все поля пусты — никаких "пустых" заголовков.
 * Если бриф полностью пуст — возвращает ''.
 */
export function compileBriefText(fields: ClientBriefFields): string {
  const sections = [
    buildCompanySection(fields),
    buildProductSection(fields),
    buildAudienceSection(fields),
    buildCommunicationSection(fields),
    buildEvidenceSection(fields),
    buildSocialProofSection(fields),
    buildAdditionalSection(fields),
  ].filter((s): s is string => s !== null);

  if (sections.length === 0) return '';

  return ['# Бриф клиента', '', ...sections].join('\n\n');
}
