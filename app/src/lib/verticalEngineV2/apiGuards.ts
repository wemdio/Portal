/**
 * Скоуп-проверки владельца для клиентского ENG-контуру «Движка вертикалей»
 * (api/client/eng/*): клиент видит и меняет только проекты, где
 * ve_projects.created_by = его user id. Чужие идентификаторы отвечают 404
 * (существование объекта не раскрываем), инфраструктурные ошибки — 500.
 *
 * Каждый лоадер грузит целевую строку + её проект и сверяет владельца.
 * Сообщения EN — это клиентский контур с английским UI.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface VeScopeFailure {
  status: number;
  message: string;
}

export type VeScopeResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; failure: VeScopeFailure };

type Row = Record<string, unknown>;

function notFound(message: string): VeScopeFailure {
  return { status: 404, message };
}

function dbError(message: string): VeScopeFailure {
  return { status: 500, message };
}

/** PGRST116 («строк нет») — легитимное отсутствие; прочие ошибки — сбой БД. */
function failureFrom(error: { message: string; code?: string } | null, notFoundMessage: string): VeScopeFailure {
  return error?.code === 'PGRST116' ? notFound(notFoundMessage) : dbError(error?.message ?? 'Database error');
}

/** Проект, принадлежащий клиенту (created_by = userId). */
export async function loadClientVeProject(
  supabase: SupabaseClient,
  projectId: string,
  userId: string,
): Promise<VeScopeResult<{ project: Row }>> {
  const { data: project, error } = await supabase
    .from('ve_projects')
    .select('*')
    .eq('id', projectId)
    .eq('created_by', userId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Project not found') };
  return { ok: true, project: project as Row };
}

/**
 * Проект-владелец для дочерней сущности. foundProject=false означает «проекта
 * нет или он чужой» — наружу всегда 404, различать не нужно.
 */
async function loadOwnedProject(
  supabase: SupabaseClient,
  projectId: string,
  userId: string,
  notFoundMessage: string,
): Promise<{ project: Row } | { failure: VeScopeFailure }> {
  const { data: project, error } = await supabase
    .from('ve_projects')
    .select('id, created_by, market, status')
    .eq('id', projectId)
    .single();
  if (error) return { failure: failureFrom(error, notFoundMessage) };
  if ((project as Row).created_by !== userId) return { failure: notFound(notFoundMessage) };
  return { project: project as Row };
}

export async function loadClientVeVertical(
  supabase: SupabaseClient,
  verticalId: string,
  userId: string,
): Promise<VeScopeResult<{ vertical: Row; project: Row }>> {
  const { data: vertical, error } = await supabase
    .from('ve_verticals')
    .select('id, project_id, name')
    .eq('id', verticalId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Vertical not found') };
  const owned = await loadOwnedProject(supabase, (vertical as Row).project_id as string, userId, 'Vertical not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, vertical: vertical as Row, project: owned.project };
}

export async function loadClientVeHypothesis(
  supabase: SupabaseClient,
  hypothesisId: string,
  userId: string,
): Promise<VeScopeResult<{ hypothesis: Row; project: Row }>> {
  const { data: hypothesis, error } = await supabase
    .from('ve_hypotheses')
    .select('id, project_id')
    .eq('id', hypothesisId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Hypothesis not found') };
  const owned = await loadOwnedProject(supabase, (hypothesis as Row).project_id as string, userId, 'Hypothesis not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, hypothesis: hypothesis as Row, project: owned.project };
}

export async function loadClientVeBase(
  supabase: SupabaseClient,
  baseId: string,
  userId: string,
): Promise<VeScopeResult<{ base: Row; project: Row }>> {
  const { data: base, error } = await supabase
    .from('ve_bases')
    .select('id, project_id, status')
    .eq('id', baseId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Base not found') };
  const owned = await loadOwnedProject(supabase, (base as Row).project_id as string, userId, 'Base not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, base: base as Row, project: owned.project };
}

/** Цепочка → вертикаль → проект (у ve_chains нет project_id). */
export async function loadClientVeChain(
  supabase: SupabaseClient,
  chainId: string,
  userId: string,
): Promise<VeScopeResult<{ chain: Row; vertical: Row; project: Row }>> {
  const { data: chain, error } = await supabase
    .from('ve_chains')
    .select('id, vertical_id')
    .eq('id', chainId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Chain not found') };
  const { data: vertical, error: vertErr } = await supabase
    .from('ve_verticals')
    .select('id, project_id')
    .eq('id', (chain as Row).vertical_id as string)
    .single();
  if (vertErr) return { ok: false, failure: failureFrom(vertErr, 'Chain not found') };
  const owned = await loadOwnedProject(supabase, (vertical as Row).project_id as string, userId, 'Chain not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, chain: chain as Row, vertical: vertical as Row, project: owned.project };
}

/** Шаблон → вертикаль → проект (у ve_templates нет project_id). */
export async function loadClientVeTemplate(
  supabase: SupabaseClient,
  templateId: string,
  userId: string,
): Promise<VeScopeResult<{ template: Row; project: Row }>> {
  const { data: template, error } = await supabase
    .from('ve_templates')
    .select('id, vertical_id')
    .eq('id', templateId)
    .single();
  if (error) return { ok: false, failure: failureFrom(error, 'Template not found') };
  const { data: vertical, error: vertErr } = await supabase
    .from('ve_verticals')
    .select('id, project_id')
    .eq('id', (template as Row).vertical_id as string)
    .single();
  if (vertErr) return { ok: false, failure: failureFrom(vertErr, 'Template not found') };
  const owned = await loadOwnedProject(supabase, (vertical as Row).project_id as string, userId, 'Template not found');
  if ('failure' in owned) return { ok: false, failure: owned.failure };
  return { ok: true, template: template as Row, project: owned.project };
}
