import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';

// Capture CI identity before dotenv loads project files with `override: true`.
// A local/project env file must never be able to disable Next's typecheck.
const semaphoreBranchCiRequestedTypecheckSkip =
  process.env.CI === 'true' &&
  process.env.SEMAPHORE === 'true' &&
  process.env.SEMAPHORE_GIT_REF_TYPE === 'branch' &&
  Boolean(process.env.SEMAPHORE_GIT_BRANCH) &&
  !['main', 'test'].includes(process.env.SEMAPHORE_GIT_BRANCH ?? '') &&
  process.env.NEXT_BUILD_SKIP_TYPECHECK === '1';
const explicitlyPrecheckedBuildRequestedTypecheckSkip =
  process.env.NEXT_BUILD_SKIP_TYPECHECK === '1' &&
  process.env.NEXT_BUILD_PRECHECKED_TYPECHECK === '1';

// UI_ONLY=1 skips loading the real ../.env — no Supabase env means middleware
// disables auth (renders pages without login) and the browser client falls
// back to a dead URL, so data fetches surface empty/error states. Lets the UI
// be reviewed locally with zero backend. `npm run dev:ui` sets the flag.
// .env.local грузится последним и перекрывает .env — как в Next.js.
const envCandidates = [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.local')];
if (process.env.UI_ONLY !== '1') {
  for (const envPath of envCandidates) {
    config({ path: envPath, override: true });
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// Branch CI и production Docker сначала запускают общий `typecheck:strict`.
// После успешного precheck пропускаем только повторную проверку Next, которая
// не помещается в 4 ГБ e1-standard-2. Обычные локальные сборки остаются строгими.
const skipDuplicateCiTypecheck =
  semaphoreBranchCiRequestedTypecheckSkip || explicitlyPrecheckedBuildRequestedTypecheckSkip;

/**
 * Заголовки безопасности на все ответы (аудит 26.10.2026: портал не отдавал
 * ни одного). Встраивать портал в чужие сайты нельзя — иначе страницу с
 * кнопками можно спрятать под чужой интерфейс и подсунуть клик
 * (кликджекинг). Разрешены свои домены и Telegram: мини-приложение портала в
 * веб-версии Telegram открывается во фрейме. HSTS без includeSubDomains —
 * поддомены могут жить без TLS.
 */
const SECURITY_HEADERS = [
  {
    key: 'Content-Security-Policy',
    value:
      "frame-ancestors 'self' https://polza-portal.ru https://*.polza-portal.ru " +
      'https://outreachos.xyz https://*.outreachos.xyz https://web.telegram.org https://*.telegram.org',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

const nextConfig: NextConfig = {
  // Без «X-Powered-By: Next.js» — лишняя подсказка, чем атаковать.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  typescript: {
    ignoreBuildErrors: skipDuplicateCiTypecheck,
  },
  turbopack: {
    root: __dirname,
  },
  output: 'standalone', // Enable standalone output for Docker
  typedRoutes: true,
  experimental: {
    typedRoutes: true,
    // Тело каждого не-GET запроса Next копирует в память ДО middleware, то есть
    // ещё до проверки входа. При 600 МБ несколько анонимных POST забивали память
    // портала (аудит 27.10.2026). Аудио льётся в S3 напрямую (presign), самая
    // большая загрузка через портал — источник для ИНН, до 80 МБ. Тот же предел
    // стоит в nginx (client_max_body_size 200m). Server actions в app/src нет —
    // их лимит не задаём, остаётся дефолт.
    proxyClientMaxBodySize: '200mb',
    optimizePackageImports: [
      'lucide-react',
      '@phosphor-icons/react',
      'date-fns',
    ],
  },
  outputFileTracingIncludes: {
    '/api/brief-scoring/parse-pdf': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    ],
    // Пакет внешний (см. serverExternalPackages), и трассировщик утаскивает в
    // образ только ESM-половину — CJS-точки входа не оказывается, а сервер
    // standalone грузит модули через require. Забираем пакеты целиком, иначе
    // загрузка архивов падает не на сборке, а в рантайме на проде.
    '/api/tools/tg-outreach/accounts/bulk-files': [
      './node_modules/@mtcute/**/*',
      './node_modules/@fuman/**/*',
    ],
  },
  // @mtcute/convert читает tdata (загрузка TG-аккаунтов архивами). Его модуль
  // крипты делает `await import('@mtcute/node/utils.js')` в ветке «крипта не
  // передана» — мы её не используем, всегда передаём свою реализацию на
  // node:crypto, чтобы не тащить в образ нативный better-sqlite3. Но сборщик
  // разрешает импорты статически и падает на ненайденном пакете, поэтому
  // пакет оставляем внешним: он подключается из node_modules в рантайме.
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'dockerode', 'sqlite3', '@mtcute/convert'],
};

export default nextConfig;
