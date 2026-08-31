import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { generateBenchKey, hashBenchKey, keyLast4 } from './keys';

export interface BenchKeyLimits {
  rpm_limit: number;
  daily_jobs_limit: number;
  daily_rows_limit: number;
  max_active_jobs: number;
}

export const DEFAULT_BENCH_LIMITS: BenchKeyLimits = {
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 200_000,
  max_active_jobs: 3,
};

export interface IssuedBenchKey {
  /** Открытый ключ. Возвращается ОДИН раз и нигде не сохраняется. */
  key: string;
  id: string;
  robotUserId: string;
}

export type IssueResult =
  | { ok: true; issued: IssuedBenchKey }
  | { ok: false; error: string };

/**
 * Выдача ключа: заводит учётку-робота и привязывает к ней ключ.
 *
 * Робот — настоящий пользователь базы, но без роли: middleware не пускает
 * внутрь портала аккаунты без роли, поэтому войти под ним нельзя. Пароль
 * случайный и никуда не сохраняется — он нужен только потому, что GoTrue
 * требует его при создании пользователя.
 *
 * Открытый ключ возвращается один раз и в базе не остаётся: там только
 * отпечаток.
 */
export async function issueBenchKey(args: {
  name: string;
  tools: string[];
  limits?: Partial<BenchKeyLimits>;
  createdBy: string | null;
}): Promise<IssueResult> {
  if (!supabaseAdmin) return { ok: false, error: 'Bench API не настроен' };

  const slug = randomBytes(4).toString('hex');
  const email = `bench-robot-${slug}@robots.invalid`;

  const { data: created, error: userError } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: randomBytes(32).toString('base64url'),
    user_metadata: { bench_robot: true, issued_for: args.name },
  });
  if (userError || !created?.user) {
    return { ok: false, error: userError?.message ?? 'Не удалось создать робота' };
  }
  const robotUserId = created.user.id;

  // Триггер на auth.users мог уже создать профиль с ролью по умолчанию —
  // перезаписываем её явным null, иначе робот получил бы права сотрудника.
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert({ id: robotUserId, email, role: null, is_api_robot: true }, { onConflict: 'id' });
  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(robotUserId).catch(() => {});
    return { ok: false, error: profileError.message };
  }

  const key = generateBenchKey();
  const limits = { ...DEFAULT_BENCH_LIMITS, ...(args.limits ?? {}) };

  const { data: row, error: keyError } = await supabaseAdmin
    .from('bench_api_keys')
    .insert({
      name: args.name,
      key_hash: hashBenchKey(key),
      key_last4: keyLast4(key),
      robot_user_id: robotUserId,
      allowed_tools: args.tools,
      created_by: args.createdBy,
      ...limits,
    })
    .select('id')
    .single();

  if (keyError || !row) {
    // Робот без ключа — мусор, который потом никто не опознает.
    await supabaseAdmin.auth.admin.deleteUser(robotUserId).catch(() => {});
    return { ok: false, error: keyError?.message ?? 'Не удалось создать ключ' };
  }

  return { ok: true, issued: { key, id: String(row.id), robotUserId } };
}

/**
 * Отзыв — проставление даты, а не удаление строки: журнал обращений должен
 * пережить отзыв, иначе после инцидента нечего будет разбирать. Повторный
 * отзыв уже отозванного ключа ничего не меняет.
 */
export async function revokeBenchKey(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseAdmin) return { ok: false, error: 'Bench API не настроен' };
  const { error } = await supabaseAdmin
    .from('bench_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .is('revoked_at', null);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
