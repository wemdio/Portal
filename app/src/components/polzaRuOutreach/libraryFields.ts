/**
 * Описание полей и заголовков библиотек «Нашего автоаутрича».
 *
 * Держится отдельно от разметки: форма редактирования раскладывает поля по
 * группам, а список берёт отсюда же, что показывать в строке и по каким полям
 * искать. Добавили поле — правим только этот файл.
 */

import { CHAIN_LABELS, CHAIN_TYPES, INDUSTRY_GROUP_LABELS, INDUSTRY_GROUPS } from '@/lib/polzaRuOutreach/types';
import { MIN_CASE_LEADS, type Rec } from './libraryFilters';

export type TableKey = 'cases' | 'claims' | 'senders';
export type FieldType = 'text' | 'textarea' | 'date' | 'bool' | 'select' | 'multi';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  /** Заголовок группы в форме редактирования. */
  group: string;
  options?: Array<[string, string]>;
  hint?: string;
}

export const STATUS_OPTIONS: Array<[string, string]> = [
  ['draft', 'черновик'],
  ['approved', 'утверждено'],
  ['expired', 'истекло'],
];

export const SENDER_STATUS_OPTIONS: Array<[string, string]> = [
  ['active', 'активна'],
  ['inactive', 'выключена'],
];

export function statusOptionsFor(table: TableKey): Array<[string, string]> {
  return table === 'senders' ? SENDER_STATUS_OPTIONS : STATUS_OPTIONS;
}

export function statusLabel(table: TableKey, value: unknown): string {
  const found = statusOptionsFor(table).find(([v]) => v === value);
  return found ? found[1] : String(value ?? '');
}

export const FIELDS: Record<TableKey, Field[]> = {
  cases: [
    { group: 'Кейс', key: 'case_id', label: 'ID кейса', type: 'text', hint: 'короткий латиницей, например it_integrator_2026' },
    { group: 'Кейс', key: 'public_name', label: 'Название для писем', type: 'text' },
    {
      group: 'Кейс',
      key: 'case_text_short',
      label: 'Текст для письма (1–2 предложения)',
      type: 'textarea',
      hint: 'вставляется в письмо 3 дословно после «Для примера:», с маленькой буквы',
    },
    {
      group: 'Кейс',
      key: 'case_text_en',
      label: 'Текст для английских писем',
      type: 'textarea',
      hint: 'вставляется после «For a similar … company, we helped …»; с маленькой буквы, без точки',
    },
    { group: 'Кейс', key: 'case_segment_en', label: 'Сегмент для английских писем', type: 'text', hint: 'например: B2B software, industrial manufacturing' },
    { group: 'Кейс', key: 'case_url', label: 'Ссылка на кейс', type: 'text' },

    {
      group: 'Подбор',
      key: 'leads_count',
      label: 'Сколько лидов дал кейс',
      type: 'text',
      hint: `в письма идут только кейсы от ${MIN_CASE_LEADS} лидов; пусто — кейс не используется`,
    },
    {
      group: 'Подбор',
      key: 'industry_groups',
      label: 'Отраслевые группы',
      type: 'multi',
      options: INDUSTRY_GROUPS.map((g) => [g, INDUSTRY_GROUP_LABELS[g]] as [string, string]),
      hint: 'по ним кейс подбирается к компании',
    },
    {
      group: 'Подбор',
      key: 'allowed_chains',
      label: 'В каких цепочках можно',
      type: 'multi',
      options: CHAIN_TYPES.map((c) => [c, CHAIN_LABELS[c]] as [string, string]),
      hint: 'ничего не отмечено — во всех',
    },

    { group: 'Служебное', key: 'status', label: 'Статус', type: 'select', options: STATUS_OPTIONS },
    { group: 'Служебное', key: 'legal_publication_approved', label: 'Клиент разрешил упоминать', type: 'bool' },
    { group: 'Служебное', key: 'verified_by', label: 'Кто проверил цифры', type: 'text' },
    { group: 'Служебное', key: 'expires_at', label: 'Действует до', type: 'date' },
    { group: 'Служебное', key: 'source_file_or_url', label: 'Источник цифр', type: 'text' },
    { group: 'Служебное', key: 'notes', label: 'Заметки', type: 'textarea' },
  ],

  claims: [
    {
      group: 'Утверждение',
      key: 'chain_type',
      label: 'Цепочка',
      type: 'select',
      options: [['all', 'все цепочки'], ...CHAIN_TYPES.map((c) => [c, CHAIN_LABELS[c]] as [string, string])],
    },
    {
      group: 'Утверждение',
      key: 'claim_key',
      label: 'Куда вставлять',
      type: 'select',
      options: [
        ['letter2_value', 'письмо 2, после описания подхода'],
        ['sdr_role_proof', 'SDR, письмо 2: до каких ролей доходили в кампаниях клиентов'],
      ],
    },
    { group: 'Утверждение', key: 'claim_text', label: 'Текст утверждения', type: 'textarea', hint: 'все цифры, сроки и гарантии — только отсюда' },

    { group: 'Служебное', key: 'status', label: 'Статус', type: 'select', options: STATUS_OPTIONS },
    { group: 'Служебное', key: 'approved_by', label: 'Кто утвердил', type: 'text' },
    { group: 'Служебное', key: 'expires_at', label: 'Действует до', type: 'date' },
  ],

  senders: [
    { group: 'Подпись', key: 'sender_name', label: 'Имя', type: 'text' },
    { group: 'Подпись', key: 'sender_title', label: 'Должность', type: 'text' },
    { group: 'Подпись', key: 'company_name', label: 'Компания', type: 'text' },
    { group: 'Подпись', key: 'phone', label: 'Телефон', type: 'text' },
    { group: 'Подпись', key: 'website', label: 'Сайт', type: 'text' },
    { group: 'Подпись', key: 'telegram', label: 'Telegram', type: 'text' },

    { group: 'Служебное', key: 'status', label: 'Статус', type: 'select', options: SENDER_STATUS_OPTIONS },
    { group: 'Служебное', key: 'is_default', label: 'По умолчанию', type: 'bool' },
  ],
};

export interface TableMeta {
  title: string;
  /** Короткое название для меню разделов. */
  short: string;
  hint: string;
  searchFields: readonly string[];
  searchPlaceholder: string;
  /** Верхняя строка записи в списке. */
  primary: (r: Rec) => string;
  /** Нижняя строка: подробности, обрезается одной строкой. */
  secondary: (r: Rec) => string;
  /** Показывать фильтр по отрасли и бейдж с лидами. */
  isCases?: boolean;
}

export const TABLE_META: Record<TableKey, TableMeta> = {
  cases: {
    title: 'Кейсы',
    short: 'Кейсы',
    hint: `В письмо 3 попадает только утверждённый кейс с разрешением на публикацию, совпадающей отраслевой группой и от ${MIN_CASE_LEADS} лидов. Нет подходящего — письмо 3 идёт без кейса.`,
    searchFields: ['public_name', 'case_id', 'case_text_short', 'case_text_en', 'client_name_internal', 'notes'],
    searchPlaceholder: 'Название, ID или текст кейса',
    primary: (r) => String(r.public_name ?? ''),
    secondary: (r) => String(r.case_text_short ?? ''),
    isCases: true,
  },
  claims: {
    title: 'Утверждения оффера',
    short: 'Оффер',
    hint: 'Цифры, цены, сроки и гарантии. Без утверждённой записи письма остаются без цифр.',
    searchFields: ['claim_text', 'approved_by'],
    searchPlaceholder: 'Текст утверждения',
    primary: (r) => String(r.claim_text ?? ''),
    secondary: (r) => String(r.approved_by ? `утвердил ${r.approved_by}` : ''),
  },
  senders: {
    title: 'Подписи',
    short: 'Подписи',
    hint: 'Подпись берётся целиком из профиля и не смешивается с другой.',
    searchFields: ['sender_name', 'sender_title', 'company_name', 'telegram', 'website'],
    searchPlaceholder: 'Имя, компания или Telegram',
    primary: (r) => [r.sender_name, r.sender_title].filter(Boolean).join(', '),
    secondary: (r) => [r.company_name, r.phone, r.website, r.telegram].filter(Boolean).join(' · '),
  },
};
