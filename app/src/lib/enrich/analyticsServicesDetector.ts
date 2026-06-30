/**
 * Детектор сервисов сквозной аналитики и коллтрекинга («сервисы сквозной
 * аналитики»). Питает пресет «Сервисы сквозной аналитики» в модалке «Сигналы»:
 * каждый сервис → отдельная колонка «да»/'' + сводная «Обнаружено сервисов».
 *
 * Regex'ы привязаны к домену/CDN сервиса, а не к голому бренд-слову — иначе
 * фраза «мы интегрируем Roistat» в тексте давала бы ложный «да». Перенесено из
 * боевого локального скрипта `app/scripts/enrich-roistat-competitors.ts`,
 * которым студия собирала такие базы вручную.
 *
 * Порядок здесь = порядок колонок в таблице (он же зашит в ALL_EXTRACTOR_KEYS,
 * по которому sanitizeExtractorList упорядочивает выбор). Меняешь порядок —
 * синхронизируй ALL_EXTRACTOR_KEYS / BUILTIN_PRESETS.analytics / EXTRACTOR_GROUPS.
 */
import type { ExtractorKey } from '@/lib/enrich/extractors/types';

export interface AnalyticsService {
  /** Стабильный id (для дедупа/сравнения), не показывается пользователю. */
  id: string;
  /** Ключ-экстрактор → одна колонка в таблице. */
  key: ExtractorKey;
  /** Заголовок колонки (имя сервиса как в базе-примере). */
  label: string;
  /** Regex по сырому HTML главной страницы. */
  regex: RegExp;
}

export const ANALYTICS_SERVICES: AnalyticsService[] = [
  // --- Сквозная аналитика ---
  { id: 'roistat', key: 'svc_roistat', label: 'Roistat', regex: /roistat\.com|roistat\.cloud|cdn\.roistat|roistatprojectid|\bvar\s+roistat\b/i },
  { id: 'k50', key: 'svc_k50', label: 'K50', regex: /tracker\.k50|k50project\.ru|k50\.ru\/(?:tracker|track)|k50statcounter/i },
  { id: 'owox_bi', key: 'svc_owox_bi', label: 'OWOX BI', regex: /owox\.com|owox-bi|owox_bi|t\.owox\.com/i },
  // --- Лид-захват / коллбэк (коллтрекинг-смежное) ---
  { id: 'envybox', key: 'svc_envybox', label: 'Envybox', regex: /envybox\.(?:io|ru|com)|cdn\.envybox|envycrm/i },
  { id: 'smartis', key: 'svc_smartis', label: 'Smartis', regex: /smartis\.ru|cdn\.smartis|sm-id\.smartis/i },
  // --- Коллтрекинг ---
  { id: 'calltouch', key: 'svc_calltouch', label: 'Calltouch', regex: /calltouch\.ru|mod\.calltouch/i },
  { id: 'comagic', key: 'svc_comagic', label: 'CoMagic', regex: /comagic\.ru|comagic\.com|app\.comagic|callgear\.com/i },
  { id: 'mango_office', key: 'svc_mango_office', label: 'Mango Office', regex: /mango-office\.ru|widgets\.mango-office/i },
  { id: 'ringostat', key: 'svc_ringostat', label: 'Ringostat', regex: /ringostat\.com|ringostat\.net/i },
  { id: 'callibri', key: 'svc_callibri', label: 'Callibri', regex: /callibri\.ru|cdn\.callibri/i },
  { id: 'uiscom', key: 'svc_uiscom', label: 'UIScom', regex: /uiscom\.ru|web\.uiscom|app\.uiscom/i },
  { id: 'primegate', key: 'svc_primegate', label: 'PrimeGate', regex: /primegate\.io|primegate\.app|prime-gate\.ru/i },
  { id: 'alloka', key: 'svc_alloka', label: 'Alloka', regex: /alloka\.ru|cdn\.alloka/i },
];

/** Ключ сводной колонки «Обнаружено сервисов» (список найденных через запятую). */
export const ANALYTICS_SUMMARY_KEY: ExtractorKey = 'analytics_services';

/**
 * Все ключи-экстракторы фичи (13 по-сервисных + сводный). Используется в
 * websiteSignalProcessor, чтобы запускать детект только если хоть один из них
 * выбран (детект дешёвый — по уже скачанной главной, без подстраниц).
 */
export const ANALYTICS_SERVICE_KEYS: ReadonlySet<ExtractorKey> = new Set<ExtractorKey>([
  ...ANALYTICS_SERVICES.map((s) => s.key),
  ANALYTICS_SUMMARY_KEY,
]);

export interface DetectedAnalyticsService {
  id: string;
  label: string;
}

/** Найденные сервисы по сырому HTML (в порядке ANALYTICS_SERVICES). */
export function detectAnalyticsServices(html: string): DetectedAnalyticsService[] {
  if (!html) return [];
  const out: DetectedAnalyticsService[] = [];
  for (const svc of ANALYTICS_SERVICES) {
    if (svc.regex.test(html)) out.push({ id: svc.id, label: svc.label });
  }
  return out;
}
