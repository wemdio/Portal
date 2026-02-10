import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';

const envCandidates = [resolve(__dirname, '..', '.env')];

const parsedEnv: Record<string, string> = {};
for (const envPath of envCandidates) {
  const result = config({ path: envPath, override: false });
  if (result.parsed) {
    Object.assign(parsedEnv, result.parsed);
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? parsedEnv.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? parsedEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
