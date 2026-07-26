import { NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { verifyBoardToken, boardTokenSecret } from './boardToken';
import { parseColumnConfig, type BoardColumnConfigEntry } from '@/lib/instantly/leadBoardWriter';

/**
 * Общая авторизация гостевых lead-board API: capability-токен (HMAC + равенство
 * сохранённому в project_lead_boards.token; не совпал = отозван). Используется
 * публичными роутами /api/lead-board/[token](/**) — middleware их пропускает,
 * сессии здесь нет, токен и есть доступ.
 */

export interface ResolvedBoard {
  projectId: string;
  columnConfig: BoardColumnConfigEntry[];
  db: NonNullable<typeof supabaseInstantly>;
}

export function jsonBoardError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function resolveBoard(
  token: string,
): Promise<{ board?: ResolvedBoard; error?: NextResponse }> {
  if (!supabaseInstantly) return { error: jsonBoardError('Server misconfigured', 500) };
  const db = supabaseInstantly;
  const secret = boardTokenSecret();
  if (!secret) return { error: jsonBoardError('Server misconfigured', 500) };

  const projectId = verifyBoardToken(token, secret);
  if (!projectId) return { error: jsonBoardError('Invalid token', 401) };

  const { data, error } = await db
    .from('project_lead_boards')
    .select('token, column_config')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) return { error: jsonBoardError(error.message, 500) };
  // Токен обязан совпасть с сохранённым: иначе он отозван (регенерирован).
  if (!data || (data.token as string) !== token) {
    return { error: jsonBoardError('Token invalid or revoked', 401) };
  }
  return { board: { projectId, columnConfig: parseColumnConfig(data.column_config), db } };
}
