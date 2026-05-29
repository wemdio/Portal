import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';
// UI_ONLY=1 skips loading the real ../.env — no Supabase env means middleware
// disables auth (renders pages without login) and the browser client falls
// back to a dead URL, so data fetches surface the empty/error states. Lets us
// review the UI locally with zero backend. `npm run dev:ui` sets the flag.
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
  },
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', 'dockerode', 'sqlite3'],
};

export default nextConfig;
