import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { filterAllowedIds } from '@/lib/clientAccess';
import { listAllLeads, listAllCampaigns } from '@/lib/instantly/client';
import type { Campaign } from '@/lib/instantly/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { cached, invalidate } from '@/lib/clientCache';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const CONCURRENCY = 3;

const CAMPAIGNS_TTL = 5 * 60 * 1000;
const BATCH_SIZE = 500;

export type SyncProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; done: number; total: number; campaign_name: string; leads_count: number }
  | { type: 'done'; campaigns: CampaignResult[]; synced: number }
  | { type: 'error'; message: string };

interface CampaignResult {
  id: string;
  name: string;
  leads_count: number;
  leads_synced_at: string;
  leads: LeadResult[];
}

interface LeadResult {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
}

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { userId, accessRows } = result.auth;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  if (allowedCampaignIds.length === 0) {
    return Response.json({ campaigns: [], synced: 0 });
  }

  const enc = new TextEncoder();
  const send = (event: SyncProgressEvent) => enc.encode(JSON.stringify(event) + '\n');

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(send({ type: 'start', total: allowedCampaignIds.length }));

        let totalSynced = 0;
        let doneCount = 0;

        invalidate('instantly:campaigns:all');
        const campaignNames = await cached<Campaign[]>(
          'instantly:campaigns:all',
          () => listAllCampaigns(),
          CAMPAIGNS_TTL,
        );
        const nameMap = new Map(campaignNames.map((c) => [c.id, c.name]));

        const syncOneCampaign = async (campaignId: string) => {
          const campaignName = nameMap.get(campaignId) ?? campaignId;

          const rawLeads = await listAllLeads(campaignId, 10_000);
          const leads = rawLeads.filter((l) => l.campaign_id === campaignId);

          if (leads.length > 0) {
            const rows = leads.map((l) => ({
              client_user_id: userId,
              campaign_id: campaignId,
              email: l.email,
              first_name: l.first_name ?? null,
              last_name: l.last_name ?? null,
              company_name: l.company_name ?? null,
              website: l.website ?? null,
              linkedin_url: l.linkedin_url ?? null,
              synced_at: new Date().toISOString(),
            }));

            for (let j = 0; j < rows.length; j += BATCH_SIZE) {
              await supabaseAdmin!
                .from('client_campaign_leads')
                .upsert(rows.slice(j, j + BATCH_SIZE), {
                  onConflict: 'client_user_id,campaign_id,email',
                  ignoreDuplicates: false,
                });
            }

            totalSynced += leads.length;
          }

          await supabaseAdmin!
            .from('client_instantly_access')
            .update({ leads_synced_at: new Date().toISOString() })
            .eq('client_user_id', userId)
            .eq('resource_type', 'campaign')
            .eq('resource_id', campaignId);

          doneCount++;
          controller.enqueue(send({
            type: 'progress',
            done: doneCount,
            total: allowedCampaignIds.length,
            campaign_name: campaignName,
            leads_count: leads.length,
          }));
        };

        // Process campaigns with bounded concurrency
        const executing = new Set<Promise<void>>();
        for (const campaignId of allowedCampaignIds) {
          const task = syncOneCampaign(campaignId).finally(() => executing.delete(task));
          executing.add(task);
          if (executing.size >= CONCURRENCY) {
            await Promise.race(executing);
          }
        }
        await Promise.all(executing);

        // Build final result
        const { data: allLeads } = await supabaseAdmin!
          .from('client_campaign_leads')
          .select('campaign_id, email, first_name, last_name, company_name, website, linkedin_url')
          .eq('client_user_id', userId)
          .in('campaign_id', allowedCampaignIds);

        const grouped = new Map<string, LeadResult[]>();
        for (const lead of allLeads ?? []) {
          const cid = lead.campaign_id as string;
          if (!grouped.has(cid)) grouped.set(cid, []);
          grouped.get(cid)!.push({
            email: lead.email as string,
            first_name: lead.first_name as string | null,
            last_name: lead.last_name as string | null,
            company_name: lead.company_name as string | null,
            website: lead.website as string | null,
            linkedin_url: lead.linkedin_url as string | null,
          });
        }

        const campaigns: CampaignResult[] = allowedCampaignIds.map((cid) => ({
          id: cid,
          name: nameMap.get(cid) ?? cid,
          leads_count: grouped.get(cid)?.length ?? 0,
          leads_synced_at: new Date().toISOString(),
          leads: grouped.get(cid) ?? [],
        }));

        controller.enqueue(send({ type: 'done', campaigns, synced: totalSynced }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Ошибка синхронизации';
        controller.enqueue(send({ type: 'error', message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
