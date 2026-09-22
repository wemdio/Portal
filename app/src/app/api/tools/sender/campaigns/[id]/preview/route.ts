import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { applyVars, followUpSubject, recipientVars } from '@/lib/sender/template';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const SAMPLE = 2;
const MAX_STEPS = 5;

interface StepInput {
  subject?: string;
  body?: string;
}

/**
 * POST — предпросмотр письма на реальных получателях базы (задача 5.6).
 *
 * Агрегата по переменным мало: пустая переменная видна только на готовом
 * письме. Здесь текст шагов прогоняется через подстановку на живых строках
 * базы кампании — то, что реально уедет лиду.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.preview' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { steps?: StepInput[] } | null;
    const steps = (body?.steps ?? []).slice(0, MAX_STEPS).filter((s) => (s.body ?? '').trim());
    if (!steps.length) return jsonError('Нет писем для предпросмотра', 400);

    const { data: campaign } = await supabaseAdmin
      .from('sender_campaigns')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!campaign) return jsonError('Кампания не найдена', 404);

    const { data: rows } = await supabaseAdmin
      .from('sender_recipients')
      .select('email, name, vars')
      .eq('campaign_id', id)
      .order('created_at')
      .limit(SAMPLE);
    const recipients = (rows ?? []) as { email: string; name: string | null; vars: Record<string, string> }[];
    if (!recipients.length) return jsonError('В кампании пока нет получателей — загрузите базу', 422);

    const samples = recipients.map((recipient) => {
      const vars = recipientVars(recipient);
      const firstSubject = applyVars(steps[0].subject ?? '', vars);
      return {
        email: recipient.email,
        steps: steps.map((step, index) => ({
          subject: index === 0
            ? firstSubject
            : followUpSubject(applyVars(step.subject ?? '', vars), firstSubject),
          body: applyVars(step.body ?? '', vars),
        })),
      };
    });

    return NextResponse.json({ samples });
  });
}
