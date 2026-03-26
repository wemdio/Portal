import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';
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
  env: {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
  },
};

export default nextConfig;
