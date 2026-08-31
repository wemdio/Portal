import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { mintRobotToken } from './robotToken';

/**
 * ЕДИНСТВЕННЫЙ способ, которым витрина ходит в данные задач и результатов.
 *
 * Клиент привязан к учётке-роботу, поэтому RLS отсекает чужие строки на
 * уровне базы. Сервисный ключ (`supabaseAdmin`) обходит RLS и в роутах
 * витрины запрещён — за этим следит тест `benchIsolation.test.ts`.
 *
 * Служебные таблицы витрины (ключи, журнал) — исключение: они лежат под RLS
 * без политик, робот их не видит, и работать с ними может только сервисная
 * роль из `auth.ts` и `journal.ts`. Данных пользователей там нет.
 */
export function createBenchDb(robotUserId: string): SupabaseClient {
  return createAuthedSupabaseClient(mintRobotToken(robotUserId));
}
