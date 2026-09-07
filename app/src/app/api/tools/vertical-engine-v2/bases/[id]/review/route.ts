import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const errors: Record<string, [number, string]> = {
  VE_REVIEW_NOT_FOUND: [404, 'База не найдена'],
  VE_REVIEW_UNSUPPORTED: [409, 'Уточнение доступно для сохранённого превью. Старая база и пополнение кампании этим действием не меняются.'],
  VE_REVIEW_BUSY: [409, 'Предыдущая обработка базы ещё не завершилась. Обновите страницу немного позже.'],
  VE_REVIEW_APPROVED: [409, 'База уже согласована или передана в запуск. Уточнение не меняет согласованную аудиторию; нужен отдельный пересмотр запуска.'],
  VE_REVIEW_EMPTY: [409, 'В сохранённом резерве нет контактов, ожидающих уточнения релевантности или повторной проверки email после незавершённой проверки.'],
};

/** No sources/LLM in HTTP. Base state and its queue entry change in one transaction. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.bases.review.post' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Некорректный ID базы' }, { status: 400 });
    const { data, error } = await supabaseAdmin.rpc('ve_enqueue_relevance_review', { p_base_id: id });
    if (error) {
      const known = Object.entries(errors).find(([code]) => error.message.includes(code))?.[1];
      if (known) return NextResponse.json({ error: known[1] }, { status: known[0] });
      return NextResponse.json({ error: 'Не удалось поставить уточнение в очередь. Контакты сохранены; обновите страницу и повторите. Если ошибка повторяется, проверьте выпуск миграции уточнения.' }, { status: 503 });
    }
    if (!data || data.ok !== true || data.base_id !== id || typeof data.job_id !== 'string') {
      return NextResponse.json({ error: 'Не удалось подтвердить постановку. Обновите страницу перед повтором.' }, { status: 503 });
    }
    return NextResponse.json(data, { status: data.existing ? 200 : 202 });
  });
}
