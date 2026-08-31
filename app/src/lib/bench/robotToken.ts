import { createHmac } from 'node:crypto';

/**
 * Токен выпускается на один запрос витрины и наружу никогда не отдаётся.
 * Короткий срок жизни означает, что даже случайно осевший в логах токен
 * бесполезен через десять минут.
 */
export const ROBOT_TOKEN_TTL_SECONDS = 600;

function segment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Пользовательский токен Supabase для учётки-робота.
 *
 * Смысл всей конструкции: подписываем тем же секретом, которым GoTrue
 * подписывает токены живых людей. Тогда для базы робот — обычный
 * пользователь, и RLS применяется к нему ровно так же. Изоляцию сторожит
 * база, а не наш код: ошибка в витрине не превращается в выдачу чужих строк.
 *
 * Альтернатива — ходить сервисным ключом с ручной подстановкой владельца в
 * каждый запрос — отвергнута сознательно: сервисный ключ обходит RLS, и
 * тогда единственной защитой остаётся безошибочность нашего кода.
 */
export function mintRobotToken(
  robotUserId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error(
      'SUPABASE_JWT_SECRET is not configured — Bench API cannot act as a robot',
    );
  }

  const header = segment({ alg: 'HS256', typ: 'JWT' });
  const payload = segment({
    sub: robotUserId,
    aud: 'authenticated',
    role: 'authenticated',
    iss: 'supabase',
    iat: nowSeconds,
    exp: nowSeconds + ROBOT_TOKEN_TTL_SECONDS,
  });
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}
