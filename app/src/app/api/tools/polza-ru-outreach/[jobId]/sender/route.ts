import type { NextRequest } from 'next/server';
import { senderStatusRoute, senderUploadRoute } from '@/lib/outreachSender/routes';

export const dynamic = 'force-dynamic';

/**
 * «Рассылка» у запуска русского автоаутрича: GET — что залито и что можно
 * долить, POST { mode: 'new' | 'append', campaignId? } — «Залить в Рассылку».
 * Обработка общая с английским — lib/outreachSender.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  return senderStatusRoute(req, 'ru', jobId);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  return senderUploadRoute(req, 'ru', jobId);
}
