// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// LI Outreach campaign runner / webhook now read Unipile creds from env
// (see refactor 39a15425). In jest we don't have a real Unipile — set
// harmless placeholders so runCampaignTick doesn't early-exit at line 131
// with "UNIPILE_DSN / UNIPILE_API_KEY not set in env, skipping". Real
// values are set on prod via the studio's shared .env.
if (!process.env.UNIPILE_DSN) process.env.UNIPILE_DSN = 'test.unipile.local:1000';
if (!process.env.UNIPILE_API_KEY) process.env.UNIPILE_API_KEY = 'test-key';

// Mock Next.js router
jest.mock('next/navigation', () => ({
  useRouter() {
    return {
      push: jest.fn(),
      replace: jest.fn(),
      prefetch: jest.fn(),
      back: jest.fn(),
      pathname: '/',
      query: {},
      asPath: '/',
    }
  },
  usePathname() {
    return '/'
  },
  useSearchParams() {
    return new URLSearchParams()
  },
}))

// Mock Supabase client
jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signInWithPassword: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(),
    })),
  },
}))
