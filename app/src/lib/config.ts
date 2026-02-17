// Конфигурация для парсеров и внешних сервисов
// Значения можно переопределять через переменные окружения, но здесь заданы дефолты.

export const SEARCH_CONFIG = {
  // Настройки Playwright для парсинга поиска
  PLAYWRIGHT: {
    ENABLED: process.env.SEARCH_PLAYWRIGHT_ENABLED !== '0', // Включено по умолчанию (кроме явного '0')
    HEADLESS: process.env.SEARCH_PLAYWRIGHT_HEADLESS !== '0',
    TIMEOUT_MS: Number(process.env.SEARCH_PLAYWRIGHT_TIMEOUT_MS) || 25000,
    REUSE_BROWSER: process.env.SEARCH_PLAYWRIGHT_REUSE_BROWSER !== '0',
  },
  
  // Настройки обогащения данных (Email)
  ENRICH: {
    EMAIL_ENABLED: process.env.SEARCH_ENRICH_EMAIL_ENABLED !== '0',
    MAX_SITES_PER_JOB: Number(process.env.SEARCH_ENRICH_EMAIL_MAX_SITES_PER_JOB) || 40,
    MAX_PAGES_PER_SITE: Number(process.env.SEARCH_ENRICH_EMAIL_MAX_PAGES_PER_SITE) || 8,
    CONCURRENCY: Number(process.env.SEARCH_ENRICH_EMAIL_CONCURRENCY) || 2,
  },

  // Настройки расширения источников
  SOURCE_EXPAND: {
    ENABLED: process.env.SEARCH_SOURCE_EXPAND_ENABLED !== '0',
    MAX_SOURCES_PER_QUERY: Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SOURCES_PER_QUERY) || 2,
    MAX_SOURCES_PER_JOB: Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SOURCES_PER_JOB) || 10,
    MAX_SITES_PER_SOURCE: Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SITES_PER_SOURCE) || 25,
    CONCURRENCY: Number(process.env.SEARCH_SOURCE_EXPAND_CONCURRENCY) || 2,
  },

  QUERY_CONCURRENCY: Math.max(1, Math.min(3, Number(process.env.SEARCH_QUERY_CONCURRENCY) || 2)),
};

export const HH_CONFIG = {
  // Настройки парсера HeadHunter
  REQUEST_INTERVAL_MS: Number(process.env.HH_REQUEST_INTERVAL_MS) || 1200,
  MAX_RETRIES: Number(process.env.HH_MAX_RETRIES) || 7,
  PROXY_URL: process.env.HH_PROXY_URL || '',
};

export const YANDEX_MAPS_CONFIG = {
  // URL сервиса парсера Яндекс.Карт
  // По умолчанию для продакшена (Docker): http://yandexmaps:8000
  // Для локальной разработки (Next.js + Python локально): http://127.0.0.1:8010
  SERVICE_URL: process.env.YANDEXMAPS_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'http://yandexmaps:8000' : 'http://127.0.0.1:8010'),
  PROXY_ENCRYPTION_KEY: process.env.YANDEXMAPS_PROXY_ENCRYPTION_KEY || '',
};
