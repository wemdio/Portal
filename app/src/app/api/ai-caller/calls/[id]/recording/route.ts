import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { resolveAiCallerProvider } from '@/lib/ai-caller-request-provider';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET — proxy audio recording (handles ElevenLabs auth transparently) */
export async function GET(req: NextRequest, ctx: Ctx) {
  const token =
    getBearerToken(req.headers.get('authorization')) ||
    new URL(req.url).searchParams.get('token') ||
    '';
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const provider = resolveAiCallerProvider(req);

  if (provider === 'elevenlabs') {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return NextResponse.json({ error: 'ELEVENLABS_API_KEY not set' }, { status: 500 });

    const url = `https://api.elevenlabs.io/v1/convai/conversations/${id}/audio`;
    const fetchOpts: Record<string, unknown> = {
      headers: { 'xi-api-key': apiKey },
    };
    const proxyUrl = process.env.ELEVENLABS_PROXY_URL;
    if (proxyUrl) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProxyAgent } = require('undici') as typeof import('undici');
        fetchOpts.dispatcher = new ProxyAgent(proxyUrl);
      } catch { /* no proxy available */ }
    }
    const upstream = await fetch(url, fetchOpts as RequestInit);

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `ElevenLabs ${upstream.status}` },
        { status: upstream.status },
      );
    }

    const contentType = upstream.headers.get('content-type') ?? 'audio/mpeg';
    const body = upstream.body;

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }

  // Vapi: redirect to public recording URL
  const { getCall } = await import('@/lib/ai-caller-provider');
  const call = (await getCall(id, provider)) as Record<string, unknown>;
  const recordingUrl =
    (call.recordingUrl as string) ||
    ((call.artifact as Record<string, unknown>)?.recordingUrl as string) ||
    '';

  if (!recordingUrl) {
    return NextResponse.json({ error: 'No recording' }, { status: 404 });
  }

  return NextResponse.redirect(recordingUrl);
}
