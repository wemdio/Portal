import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const checks: Record<string, 'ok' | 'fail'> = {}
  let healthy = true

  if (!supabaseAdmin) {
    return NextResponse.json(
      { status: 'fail', checks: { config: 'fail' }, error: 'supabaseAdmin not configured' },
      { status: 503 },
    )
  }

  try {
    const { error } = await supabaseAdmin.from('profiles').select('id').limit(1)
    checks.database = error ? 'fail' : 'ok'
    if (error) healthy = false
  } catch {
    checks.database = 'fail'
    healthy = false
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1 })
    checks.auth = error ? 'fail' : 'ok'
    if (error) healthy = false
  } catch {
    checks.auth = 'fail'
    healthy = false
  }

  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    { status: healthy ? 200 : 503 },
  )
}
