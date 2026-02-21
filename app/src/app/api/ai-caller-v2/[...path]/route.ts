import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path?: string[] }> };

async function proxyToV1(req: NextRequest, ctx: Ctx) {
  const { path = [] } = await ctx.params;
  const suffix = path.join('/');
  const targetUrl = new URL(`/api/ai-caller/${suffix}`, req.url);
  targetUrl.search = req.nextUrl.search;

  const headers = new Headers();
  const authorization = req.headers.get('authorization');
  const contentType = req.headers.get('content-type');

  if (authorization) headers.set('authorization', authorization);
  if (contentType) headers.set('content-type', contentType);
  headers.set('x-ai-caller-provider', 'elevenlabs');

  const isBodyAllowed = req.method !== 'GET' && req.method !== 'HEAD';
  const body = isBodyAllowed ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
    cache: 'no-store',
  });

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get('content-type');
  if (upstreamContentType) {
    responseHeaders.set('content-type', upstreamContentType);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  return proxyToV1(req, ctx);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return proxyToV1(req, ctx);
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  return proxyToV1(req, ctx);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return proxyToV1(req, ctx);
}
