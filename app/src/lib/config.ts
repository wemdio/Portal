// Конфигурация для парсеров и внешних сервисов
// Значения можно переопределять через переменные окружения, но здесь заданы дефолты.

export const SEARCH_CONFIG = {
  // Логи и диагностика
  PROXY_DEBUG: process.env.SEARCH_PROXY_DEBUG === '1',

  // Настройки Playwright для парсинга поиска
  PLAYWRIGHT: {
    // Enabled by default in dev/prod; disabled by default in tests to avoid launching browsers in Jest.
    ENABLED:
      process.env.SEARCH_PLAYWRIGHT_ENABLED != null
        ? process.env.SEARCH_PLAYWRIGHT_ENABLED !== '0'
        : process.env.NODE_ENV !== 'test',
    // Default to headless: parsing should run in background without visible browser windows.
    HEADLESS:
      process.env.SEARCH_PLAYWRIGHT_HEADLESS != null
        ? process.env.SEARCH_PLAYWRIGHT_HEADLESS !== '0'
        : true,
    // Do not keep the browser window open; background-only by default.
    OBSERVE_MS:
      process.env.SEARCH_PLAYWRIGHT_OBSERVE_MS != null
        ? Math.max(0, Math.floor(Number(process.env.SEARCH_PLAYWRIGHT_OBSERVE_MS) || 0))
        : 0,
    TIMEOUT_MS: Number(process.env.SEARCH_PLAYWRIGHT_TIMEOUT_MS) || 25000,
    REUSE_BROWSER: process.env.SEARCH_PLAYWRIGHT_REUSE_BROWSER !== '0',
  },
  
  // Настройки обогащения данных (Email)
  ENRICH: {
    EMAIL_ENABLED: process.env.SEARCH_ENRICH_EMAIL_ENABLED !== '0',
    // Default higher: many sites expose emails only on /contacts, so enrichment needs a decent budget.
    MAX_SITES_PER_JOB: Number(process.env.SEARCH_ENRICH_EMAIL_MAX_SITES_PER_JOB) || 1000,
    MAX_PAGES_PER_SITE: Number(process.env.SEARCH_ENRICH_EMAIL_MAX_PAGES_PER_SITE) || 3,
    CONCURRENCY: 2,
  },

  // Настройки расширения источников
  SOURCE_EXPAND: {
    ENABLED: process.env.SEARCH_SOURCE_EXPAND_ENABLED !== '0',
    MAX_SOURCES_PER_QUERY: Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SOURCES_PER_QUERY) || 24,
    MAX_SOURCES_PER_JOB: Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SOURCES_PER_JOB) || 800,
    MAX_SITES_PER_SOURCE: Number(process.env.SEARCH_SOURCE_EXPAND_MAX_SITES_PER_SOURCE) || 800,
    CONCURRENCY: 3,
  },

  // Serper API: сколько страниц Google запрашивать на каждый поисковый запрос (1–30).
  SERPER_PAGES: Math.max(1, Math.min(30, Number(process.env.SEARCH_SERPER_PAGES) || 5)),

  // Стабильность важнее скорости — bursty traffic быстро ловит блоки.
  QUERY_CONCURRENCY: 2,
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
