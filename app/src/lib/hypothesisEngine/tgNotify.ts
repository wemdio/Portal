/**
 * TG-уведомления «Движка вертикалей»: шлём создателю проекта, когда
 * research-пайплайн завершился (clustering → проект researched) или финально
 * упал (attempts исчерпаны → проект failed). Вызывается из worker/hypothesisEngine.
 *
 * Транспорт — общий agent-бот портала (@Polza_portal_bot, TG_AGENT_BOT_TOKEN,
 * lib/telegramAgent/telegram): привязка Telegram делается именно через него,
 * поэтому это единственный бот, у которого гарантированно есть чат с юзером.
 * Юзер → chat_id резолвится таблицей telegram_links (telegram_id == chat_id
 * лички с ботом). Нет привязки/токена — молча пропускаем (только log).
 *
 * Контракт: функции НИКОГДА не бросают — уведомление не должно ломать
 * обработку джобы.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendMessage } from '@/lib/telegramAgent/telegram';
import type { HeProject, HeStage } from './types';

type NotifyLog = (level: 'info' | 'warn' | 'error', msg: string) => void;

const HE_TOOL_PATH = '/tools/hypothesis-engine';
const ERROR_PREVIEW_LEN = 300;

/** Русская плюрализация: (1, 'вертикаль', 'вертикали', 'вертикалей'). */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Абсолютная ссылка на тулзу, если задан публичный base URL портала; иначе относительный путь. */
export function buildHeToolUrl(): string {
  const base = (process.env.PORTAL_PUBLIC_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  return base ? `${base}${HE_TOOL_PATH}` : HE_TOOL_PATH;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildResearchDoneMessage(args: {
  projectName: string;
  verticalsCount: number;
  hypothesesCount: number;
  url: string;
}): string {
  const verticals = pluralRu(args.verticalsCount, 'вертикаль', 'вертикали', 'вертикалей');
  const hypotheses = pluralRu(args.hypothesesCount, 'гипотеза', 'гипотезы', 'гипотез');
  return (
    `✅ Исследование готово: ${escapeHtml(args.projectName)} — ` +
    `${args.verticalsCount} ${verticals} из ${args.hypothesesCount} ${hypotheses}.\n` +
    `Смотреть: ${args.url}`
  );
}

export function buildResearchFailedMessage(args: {
  projectName: string;
  stage: HeStage;
  error: string;
  url: string;
}): string {
  const errorPreview = args.error.length > ERROR_PREVIEW_LEN
    ? `${args.error.slice(0, ERROR_PREVIEW_LEN).trimEnd()}…`
    : args.error;
  return (
    `❌ Исследование не удалось: ${escapeHtml(args.projectName)} — ` +
    `стадия ${args.stage}: ${escapeHtml(errorPreview)}\n` +
    `Подробнее: ${args.url}`
  );
}

/** telegram_links.telegram_id юзера как число; null — привязки нет/битая. */
export async function resolveTelegramChatId(
  supabase: SupabaseClient,
  userId: string,
): Promise<number | null> {
  const { data: link, error } = await supabase
    .from('telegram_links')
    .select('telegram_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !link) return null;
  const chatId = Number((link as { telegram_id?: string | number | null }).telegram_id);
  return Number.isFinite(chatId) && chatId > 0 ? chatId : null;
}

async function countRows(supabase: SupabaseClient, table: string, projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId);
  return error ? 0 : (count ?? 0);
}

/**
 * Общий путь: проект → created_by → telegram_links → sendMessage.
 * Возвращает false, если доставка не состоялась (skip уже залогирован).
 */
async function deliverToProjectOwner(
  supabase: SupabaseClient,
  projectId: string,
  buildText: (project: Pick<HeProject, 'name'>) => string | Promise<string>,
  log?: NotifyLog,
): Promise<boolean> {
  if (!process.env.TG_AGENT_BOT_TOKEN) {
    log?.('warn', `he-notify: skip project ${projectId} — TG_AGENT_BOT_TOKEN не задан`);
    return false;
  }

  const { data: project, error } = await supabase
    .from('he_projects')
    .select('name, created_by')
    .eq('id', projectId)
    .maybeSingle();
  if (error || !project) {
    log?.('warn', `he-notify: skip — проект ${projectId} не найден (${error?.message ?? 'no row'})`);
    return false;
  }
  const p = project as Pick<HeProject, 'name' | 'created_by'>;
  if (!p.created_by) {
    log?.('info', `he-notify: skip project ${projectId} — created_by пуст`);
    return false;
  }

  const chatId = await resolveTelegramChatId(supabase, p.created_by);
  if (!chatId) {
    log?.('info', `he-notify: skip project ${projectId} — у ${p.created_by} нет привязанного Telegram`);
    return false;
  }

  await sendMessage(chatId, await buildText(p));
  log?.('info', `he-notify: sent to chat ${chatId} (project ${projectId})`);
  return true;
}

/** «✅ Исследование готово…» после clustering (проект → researched). Никогда не бросает. */
export async function notifyHeResearchDone(
  supabase: SupabaseClient,
  projectId: string,
  log?: NotifyLog,
): Promise<void> {
  try {
    const url = buildHeToolUrl();
    await deliverToProjectOwner(
      supabase,
      projectId,
      async (project) => buildResearchDoneMessage({
        projectName: project.name,
        verticalsCount: await countRows(supabase, 'he_verticals', projectId),
        hypothesesCount: await countRows(supabase, 'he_hypotheses', projectId),
        url,
      }),
      log,
    );
  } catch (err) {
    log?.('error', `he-notify: done-notify project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** «❌ Исследование не удалось…» при финальном фейле research-стадии. Никогда не бросает. */
export async function notifyHeResearchFailed(
  supabase: SupabaseClient,
  projectId: string,
  stage: HeStage,
  error: string,
  log?: NotifyLog,
): Promise<void> {
  try {
    const url = buildHeToolUrl();
    await deliverToProjectOwner(
      supabase,
      projectId,
      (project) => buildResearchFailedMessage({ projectName: project.name, stage, error, url }),
      log,
    );
  } catch (err) {
    log?.('error', `he-notify: fail-notify project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
