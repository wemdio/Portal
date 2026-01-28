import type { NextConfig } from "next";
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from project root (parent directory)
// This makes NEXT_PUBLIC_ variables available during build time
const envPath = resolve(__dirname, '../.env.local');
config({ path: envPath });

// Also try .env if .env.local doesn't exist
const envPathFallback = resolve(__dirname, '../.env');
config({ path: envPathFallback });

const nextConfig: NextConfig = {
  /* config options here */
  output: 'standalone', // Enable standalone output for Docker
  env: {
    // Explicitly pass environment variables to Next.js
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
};

export default nextConfig;
