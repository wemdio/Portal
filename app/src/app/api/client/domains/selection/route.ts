import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import type { SuggestedDomain } from '@/lib/clientDomains/constants';
import { invalidate } from '@/lib/clientCache';
import {
  notifyManagersOfDomainSelection,
  sendDomainSelectionTelegramAlert,
} from '@/lib/clientDomains/notify';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/client/domains/selection
 * body: { selected: string[] }
 *
 * Confirms the client's domain picks. Validation is strict: exactly
 * required_count domains, all from the current suggested batch with
 * available=true — the manager buys exactly what was confirmed, so a stale
 * or hand-crafted list must not pass.
 *
 * On success the managers are notified (bell + Telegram) — purchase, DNS and
 * mailboxes stay a manual manager process.
 */

interface PutBody {
  selected?: unknown;
}

interface SelectionRow {
  brand: string | null;
  suggested: SuggestedDomain[] | null;
  selected: string[] | null;
  required_count: number | null;
  status: string | null;
}

export async function PUT(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return jsonError('Некорректный JSON', 400);
  }

  const rawSelected = body.selected;
  if (
    !Array.isArray(rawSelected) ||
    rawSelected.some((d) => typeof d !== 'string')
  ) {
    return jsonError('selected должен быть массивом доменов', 400);
  }
  // Нормализация ДО dedup: иначе ['acme.ru', 'ACME.ru '] засчитывалось бы
  // как два разных домена и обходило проверку «ровно N».
  const selected = [
    ...new Set((rawSelected as string[]).map((d) => d.trim().toLowerCase())),
  ];

  try {
    const { data: rowData } = await supabaseInstantly
      .from('client_domain_selections')
      .select('brand, suggested, selected, required_count, status')
      .eq('client_user_id', userId)
      .maybeSingle();
    const row = (rowData as SelectionRow | null) ?? null;
    if (!row) {
      return jsonError('Сначала получите варианты доменов', 409);
    }

    const requiredCount = row.required_count ?? 0;
    if (requiredCount <= 0) {
      // Строка в неконсистентном состоянии — не принимаем никакой выбор.
      return jsonError('Сначала получите варианты доменов', 409);
    }
    if (selected.length !== requiredCount) {
      return jsonError(`Нужно выбрать ровно ${requiredCount} доменов`, 400);
    }

    const available = new Set(
      (Array.isArray(row.suggested) ? row.suggested : [])
        .filter((s) => s.available)
        .map((s) => s.domain.toLowerCase()),
    );
    const unknown = selected.filter((d) => !available.has(d));
    if (unknown.length > 0) {
      return jsonError(
        `Эти домены недоступны или не входят в предложенные варианты: ${unknown.join(', ')}`,
        400,
      );
    }

    const { error } = await supabaseInstantly
      .from('client_domain_selections')
      .upsert(
        {
          client_user_id: userId,
          brand: row.brand,
          suggested: row.suggested ?? [],
          selected,
          required_count: requiredCount,
          status: 'selected',
        },
        { onConflict: 'client_user_id' },
      );

    if (error) {
      await logError('client.domains.selection.put.failed', error, { userId });
      return jsonError('Не удалось сохранить выбор', 500);
    }

    await logAudit('client.domains.selection.put.success', 'Client confirmed domain selection', {
      userId,
      count: selected.length,
    });

    // The checklist refetches right after confirm — don't let it see the
    // pre-selection state for another cache TTL.
    invalidate(`client-onboarding:${userId}`);

    // ── Manager notification (bell fanout + Telegram) ──────────────────
    // Non-blocking: the selection is already saved, a notification failure
    // must not fail the client's request — hence the dedicated try/catch.
    if (supabaseAdmin) {
      try {
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .maybeSingle();

        const clientDisplayName =
          (profile?.full_name as string | null)?.trim() ||
          (profile?.email as string | null) ||
          'клиент';

        await notifyManagersOfDomainSelection({
          db: supabaseAdmin,
          clientUserId: userId,
          clientDisplayName,
          domains: selected,
        });

        void sendDomainSelectionTelegramAlert({
          clientDisplayName,
          domains: selected,
          clientUserId: userId,
        });
      } catch (notifyErr) {
        await logError('client.domains.selection.notify.failed', notifyErr, { userId });
      }
    }

    return NextResponse.json({
      brand: row.brand ?? null,
      suggested: Array.isArray(row.suggested) ? row.suggested : [],
      selected,
      required_count: requiredCount,
      status: 'selected',
    });
  } catch (err) {
    await logError('client.domains.selection.put.failed', err, { userId });
    return jsonError('Не удалось сохранить выбор', 500);
  }
}
