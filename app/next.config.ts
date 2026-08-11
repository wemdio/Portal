import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';
// UI_ONLY=1 skips loading the real ../.env — no Supabase env means middleware
// disables auth (renders pages without login) and the browser client falls
// back to a dead URL, so data fetches surface empty/error states. Lets the UI
// be reviewed locally with zero backend. `npm run dev:ui` sets the flag.
const envCandidates = [resolve(__dirname, '..', '.env.local'), resolve(__dirname, '..', '.env')];
if (process.env.UI_ONLY !== '1') {
  for (const envPath of envCandidates) {
    config({ path: envPath, override: true });
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {
    root: __dirname,
  },
  output: 'standalone', // Enable standalone output for Docker
  typedRoutes: true,
  experimental: {
    typedRoutes: true,
    proxyClientMaxBodySize: '600mb',
    serverActions: {
      bodySizeLimit: '600mb',
    },
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
