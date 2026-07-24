/**
 * Стадия site_profile: фетч сайта клиента (SSRF-гейт + websiteParser) →
 * LLM-профиль → снапшот в he_projects.brief.site_profile, статус проекта
 * переводится в 'researching'.
 */

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeSiteProfileSchema } from '../schemas';
import { buildSiteProfileMessages } from '../prompts/siteProfile';
import type { HeJob } from '../types';
import { resolveFetchText } from './io';
import {
  addUsage,
  newUsage,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

export async function runSiteProfileStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);

  const fetchText = resolveFetchText(ctx);
  stageLog(ctx, `[site_profile] фетч ${project.website_url}`);
  const siteText = await fetchText(project.website_url);
  stageLog(ctx, `[site_profile] получено ${siteText.length} символов, профиль…`);

  const llm = await callLLMWithSchema(
    buildSiteProfileMessages({ websiteUrl: project.website_url, siteText }),
    HeSiteProfileSchema,
    { model: getHeModel('research'), maxTokens: 4096 },
  );
  addUsage(usage, llm);

  const brief = {
    ...(project.brief ?? {}),
    website_url: project.website_url,
    site_profile: llm.data,
    captured_at: new Date().toISOString(),
  };
  const { error } = await ctx.supabase
    .from('he_projects')
    .update({ brief, status: 'researching', updated_at: new Date().toISOString() })
    .eq('id', project.id);
  if (error) throw new Error(`he_projects update brief: ${error.message}`);

  return { result: llm.data, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
