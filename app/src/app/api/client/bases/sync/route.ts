import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Deprecated: leads are now synced automatically by the background worker every hour.
 * This endpoint is kept to avoid 404s from any cached client code.
 */
export async function POST() {
  return NextResponse.json(
    { message: 'Leads sync is now automatic. Data refreshes every hour.' },
    { status: 200 },
  );
}
