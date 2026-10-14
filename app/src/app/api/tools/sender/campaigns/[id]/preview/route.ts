import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { applyVars, followUpSubject, recipientVars } from '@/lib/sender/template';
import { pickVariant, variantLabel } from '@/lib/sender/variants';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const SAMPLE = 2;
const MAX_STEPS = 5;

interface StepInput {
  subject?: string;
  body?: string;
  /** Варианты письма шага (А/Б-тест); нет — шаг с одним письмом. */
  variants?: { subject?: string; body?: string }[];
}

/** Варианты шага в порядке номеров: А/Б-тест или единственное письмо. */
function variantsOf(step: StepInput): { subject?: string; body?: string }[] {
  const list = step.variants?.length ? step.variants : [{ subject: step.subject, body: step.body }];
  return list.filter((variant) => (variant.body ?? '').trim());
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
    const steps = (body?.steps ?? [])
      .slice(0, MAX_STEPS)
      .map((step) => variantsOf(step))
      .filter((variants) => variants.length);
    if (!steps.length) return jsonError('Нет писем для предпросмотра', 400);

    const { data: campaign } = await supabaseAdmin
      .from('sender_campaigns')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!campaign) return jsonError('Кампания не найдена', 404);

    const { data: rows } = await supabaseAdmin
      .from('sender_recipients')
      .select('id, email, name, vars')
      .eq('campaign_id', id)
      .order('created_at')
      .limit(SAMPLE);
    const recipients = (rows ?? []) as {
      id: string;
      email: string;
      name: string | null;
      vars: Record<string, string>;
    }[];
    if (!recipients.length) return jsonError('В кампании пока нет получателей — загрузите базу', 422);

    // При А/Б-тесте показываем ровно тот вариант, который уедет этому адресу:
    // вариант считается от id получателя, так же как в планировщике.
    const samples = recipients.map((recipient) => {
      const vars = recipientVars(recipient);
      const chosen = steps.map((variants, index) => {
        const variant = pickVariant(recipient.id, index + 1, variants.length);
        return { variant, letter: variants[variant - 1] };
      });
      const firstSubject = applyVars(chosen[0].letter.subject ?? '', vars);
      return {
        email: recipient.email,
        steps: chosen.map(({ letter, variant }, index) => ({
          subject: index === 0
            ? firstSubject
            : followUpSubject(applyVars(letter.subject ?? '', vars), firstSubject),
          body: applyVars(letter.body ?? '', vars),
          // Подпись варианта нужна только когда вариантов больше одного.
          variant: steps[index].length > 1 ? variantLabel(variant) : null,
        })),
      };
    });

    return NextResponse.json({ samples });
  });
}
