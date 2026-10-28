import type { SupabaseClient } from '@supabase/supabase-js';
import { PRODUCTS, type Product } from '@/lib/polzaRuOutreach/cascade';

/**
 * Настройки квалификатора ответов «Рассылки» — у папки рассылок.
 *
 * Живут в базе (sender_folders), а не в env: вкладка «Квалификация»
 * автоаутрича сохраняет их, воркер перечитывает на каждом круге, и правка
 * применяется без перезапуска. Рассылка без папки (ручная) получает значения
 * по умолчанию: оценивать по общим правилам, в чат не слать.
 *
 * В чат «Продажи Polza» — только лиды автоаутричей (папки auto_*): с 08.10.2026
 * ручные рассылки клиентов (AlialGroup) оцениваются «лид / не лид» для вкладки
 * «Письма», но их лиды нашему отделу продаж не уходят.
 */

export const LEAD_CRITERIA_MAX = 2000;
/** «Короткое КП» квалифицирующего ИИ (lib/senderAiQualifier). */
export const AI_OFFER_TEXT_MAX = 2000;

/**
 * Папка, у которой короткие КП и ссылки на КП бывают по продуктам каскада:
 * только русский автоаутрич. У остальных папок эти поля не читаются и не пишутся.
 */
export const PRODUCT_OFFER_FOLDER = 'auto_ru';

/** Текст или ссылка по продуктам каскада; продукта без значения в карте нет. */
export type ProductTexts = Partial<Record<Product, string>>;

/** Длиннее в href Telegram не принимает; читатель ссылок (process.ts, kpUrlOf) такую не берёт. */
export const KP_LINK_MAX = 1500;

/**
 * Ссылка на КП, которую сохраняем: те же правила, что у читателя (process.ts, kpUrlOf) —
 * только https, без пробелов, кавычек и логина. null — читатель такую ссылку отбросил бы.
 */
export function parseKpLink(value: string): string | null {
  const raw = value.trim();
  if (!raw || /[\s"<>]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href.length <= KP_LINK_MAX ? raw : null;
  } catch {
    return null;
  }
}

/** Карта «продукт → текст» из JSON базы: только известные продукты и непустые строки. */
export function readProductTexts(value: unknown): ProductTexts {
  const out: ProductTexts = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const product of PRODUCTS) {
    const item = (value as Record<string, unknown>)[product];
    if (typeof item === 'string' && item.trim()) out[product] = item.trim();
  }
  return out;
}

/**
 * Текст «Что считать лидом» по умолчанию — пересказ общих правил
 * квалификатора, чтобы поле не было пустым. В базу не пишется: такой текст
 * сохраняется как null, и ИИ работает по полным общим правилам, а не по
 * пересказу (свой критерий у квалификатора приоритетнее и снимает часть
 * встроенных проверок).
 */
export const DEFAULT_LEAD_CRITERIA = [
  'Лид — человек сам проявил интерес к нашему предложению:',
  '— просит цену, КП, расчёт или условия;',
  '— соглашается на звонок, встречу, демо или тест;',
  '— после письма с понятным предложением пишет «интересно» или просит материалы, кейсы, презентацию;',
  '— просит вернуться позже («напишите через месяц», «в следующем году будет актуально»).',
  'Не лид: автоответ, отказ, отписка, просто контакт коллеги или общая почта, встречная продажа своих услуг, вопрос «что вы предлагаете?» без интереса, сарказм.',
].join('\n');

/** Совпадает с текстом по умолчанию — значит, своего правила у папки нет. */
export function isDefaultLeadCriteria(text: string): boolean {
  return text.replace(/\r\n/g, '\n').trim() === DEFAULT_LEAD_CRITERIA;
}

export interface LeadSettings {
  folderId: string | null;
  folderKey: string | null;
  folderName: string | null;
  enabled: boolean;
  telegram: boolean;
  criteria: string | null;
  /**
   * Кампания Движка вертикалей (source_kind 've2'): оценка по брифу и
   * критерию проекта, лид — карточкой специалисту проекта, не в чат продаж.
   */
  route?: 'project';
  projectId?: string;
  /** Бриф проекта; '' — без брифа (null квалификатор понял бы как «искать в Instantly»). */
  briefText?: string;
  /** Адреса «Передачи лида» проекта и их корпоративные домены: письма оттуда — не лид. */
  clientParty?: { addresses: string[]; domains: string[] };
  /** Проект не прочитан — ответы его кампаний ждут повтора, остальные идут как шли. */
  projectError?: string;
}

export const DEFAULT_LEAD_SETTINGS: LeadSettings = {
  folderId: null,
  folderKey: null,
  folderName: null,
  enabled: true,
  telegram: false,
  criteria: null,
};

/** Папка автоаутрича (auto_ru, auto_en) — как isAutoFolderKey в lib/sender/folders.ts. */
function isAutoOutreachFolder(key: string): boolean {
  return key.startsWith('auto_');
}

interface FolderRow {
  id: string;
  key: string;
  name: string;
  lead_criteria: string | null;
  leads_enabled: boolean;
  leads_telegram: boolean;
}

export function settingsFromFolder(row: FolderRow): LeadSettings {
  const criteria = row.lead_criteria?.trim() ?? '';
  return {
    folderId: row.id,
    folderKey: row.key,
    folderName: row.name,
    enabled: row.leads_enabled,
    telegram: row.leads_telegram && isAutoOutreachFolder(row.key),
    criteria: criteria ? criteria.slice(0, LEAD_CRITERIA_MAX) : null,
  };
}

export interface CampaignLeadSettings {
  settings: LeadSettings;
  campaignName: string;
  /**
   * Проект Portal кампании Движка вертикалей (source_kind 've2'). Её настройки
   * накладывает projectScope.withProjectLeadSettings: модуль берут и экраны,
   * поэтому серверный код проекта здесь не подключается.
   */
  veProjectId?: string;
}

/** Настройки для набора рассылок: id рассылки → настройки её папки. */
export async function loadCampaignSettings(
  db: SupabaseClient,
  campaignIds: string[],
): Promise<Map<string, CampaignLeadSettings>> {
  const out = new Map<string, CampaignLeadSettings>();
  const ids = Array.from(new Set(campaignIds));
  if (!ids.length) return out;

  const { data, error } = await db
    .from('sender_campaigns')
    .select('id, name, source_kind, project_id, sender_folders(id, key, name, lead_criteria, leads_enabled, leads_telegram)')
    .in('id', ids);
  if (error) throw new Error(`sender_campaigns: ${error.message}`);

  type CampaignRow = { id: string; name: string; source_kind?: string | null; project_id?: string | null; sender_folders: FolderRow | FolderRow[] | null };
  for (const row of (data ?? []) as CampaignRow[]) {
    const folder = Array.isArray(row.sender_folders) ? row.sender_folders[0] ?? null : row.sender_folders;
    out.set(row.id, {
      settings: folder ? settingsFromFolder(folder) : DEFAULT_LEAD_SETTINGS,
      campaignName: row.name,
      ...(row.source_kind === 've2' && row.project_id ? { veProjectId: row.project_id } : {}),
    });
  }
  return out;
}
