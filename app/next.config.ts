import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from current directory
// This makes NEXT_PUBLIC_ variables available during build time
const envPath = resolve(process.cwd(), '.env.local');
const envResult = config({ path: envPath, override: true });

// Also try .env if .env.local doesn't exist
const envPathFallback = resolve(process.cwd(), '.env');
const fallbackResult = config({ path: envPathFallback, override: true });

const supabaseUrl =
  envResult.parsed?.NEXT_PUBLIC_SUPABASE_URL
  ?? fallbackResult.parsed?.NEXT_PUBLIC_SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL;

const supabaseAnonKey =
  envResult.parsed?.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ?? fallbackResult.parsed?.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
  env: {
    // Explicitly pass environment variables to Next.js
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
  },
};

export default nextConfig;
