import type { NextRequest } from 'next/server';
import { senderStartRoute } from '@/lib/outreachSender/routes';

export const dynamic = 'force-dynamic';

/**
 * «Запустить рассылку» с экрана запуска русского автоаутрича: POST
 * { campaignId } — только рассылку, созданную этим запуском.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  return senderStartRoute(req, 'ru', jobId);
}
