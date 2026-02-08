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
const openrouterApiKey = process.env.NEXT_PUBLIC_OPENROUTER_API_KEY ?? parsedEnv.NEXT_PUBLIC_OPENROUTER_API_KEY ?? '';
const openrouterBriefApiKey = process.env.OPENROUTER_BRIEF_API_KEY ?? parsedEnv.OPENROUTER_BRIEF_API_KEY ?? '';

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {
    root: __dirname,
  },
  output: 'standalone', // Enable standalone output for Docker
  typedRoutes: true,
  experimental: {
    typedRoutes: true,
  },
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist'],
  env: {
    // Explicitly pass environment variables to Next.js
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
    NEXT_PUBLIC_OPENROUTER_API_KEY: openrouterApiKey,
    OPENROUTER_BRIEF_API_KEY: openrouterBriefApiKey, // Server-side only (for brief scoring API route)
  },
};

export default nextConfig;
