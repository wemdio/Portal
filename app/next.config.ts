import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';

// Single source of truth for local/dev: repo root `.env` (and optional `.env.local`).
// We intentionally override any values already set (e.g. from app/.env.local) to avoid confusion.
const envCandidates = [resolve(__dirname, '..', '.env.local'), resolve(__dirname, '..', '.env')];
for (const envPath of envCandidates) {
  config({ path: envPath, override: true });
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
    proxyClientMaxBodySize: '25mb',
  },
  outputFileTracingIncludes: {
    '/api/brief-scoring/parse-pdf': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    ],
  },
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist'],
  env: {
    // Explicitly pass only public environment variables to Next.js.
    // Server-only secrets must come from runtime process.env.
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
  },
};

export default nextConfig;
