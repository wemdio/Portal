import { supabaseAdmin } from '@/lib/supabaseAdmin';

const FORBIDDEN_KW =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|call|do|set|reset|listen|notify|prepare|deallocate)\b/i;

const FORBIDDEN_SCHEMA = /\b(auth|pg_catalog|information_schema)\./i;

const FORBIDDEN_FN =
  /\b(pg_read_file|pg_read_binary_file|lo_import|lo_export|pg_ls_dir|pg_stat_file|current_setting)\b/i;

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'[^']*'/g, "''")
    .trim();
}

function validateQuery(sql: string): string | null {
  const clean = stripCommentsAndStrings(sql).toLowerCase();
  if (!clean) return 'Empty query';
  if (!/^(select|with)\s/.test(clean)) return 'Only SELECT queries are allowed.';
  if (FORBIDDEN_KW.test(clean)) return 'Query contains forbidden keywords.';
  if (FORBIDDEN_SCHEMA.test(clean)) return 'Access to system schemas not allowed.';
  if (FORBIDDEN_FN.test(clean)) return 'Forbidden function call detected.';
  return null;
}

export async function queryDatabase(sql: string): Promise<string> {
  if (!supabaseAdmin) return 'Supabase admin not configured.';

  const trimmed = sql.trim();
  const validationError = validateQuery(trimmed);
  if (validationError) return `Query rejected: ${validationError}`;

  try {
    const { data, error } = await supabaseAdmin.rpc('agent_query_readonly', {
      query_text: trimmed,
    });

    if (error) return `SQL error: ${error.message}`;

    const rows = data as unknown[];
    if (!rows || rows.length === 0) return 'Результат: 0 строк.';

    const json = JSON.stringify(rows, null, 2);
    if (json.length > 12000) {
      const truncated = JSON.stringify(rows.slice(0, 50), null, 2);
      return `${truncated}\n\n... показано 50 из ${rows.length} строк (лимит вывода).`;
    }
    return `${rows.length} строк:\n${json}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}
