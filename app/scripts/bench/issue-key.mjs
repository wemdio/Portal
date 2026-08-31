/**
 * Выдача ключа Bench API из командной строки.
 *
 *   node --env-file ../.env scripts/bench/issue-key.mjs "Дима" yandexmaps,company-base
 *
 * Заводит учётку-робота (войти под ней в браузере нельзя: роли нет, а
 * middleware не пускает внутрь портала аккаунты без роли) и ключ к ней.
 * Ключ печатается ОДИН раз: в базе лежит только его отпечаток.
 *
 * Временная мера до экрана «Ключи API» в админке — после него скрипт можно
 * удалить.
 */
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';

const [name, toolsArg] = process.argv.slice(2);
if (!name || !toolsArg) {
  console.error('Использование: issue-key.mjs "<имя получателя>" <инструменты через запятую>');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const tools = toolsArg.split(',').map((t) => t.trim()).filter(Boolean);

const slug = randomBytes(4).toString('hex');
const email = `bench-robot-${slug}@robots.invalid`;

const { data: created, error: userError } = await admin.auth.admin.createUser({
  email,
  email_confirm: true,
  // Пароль случайный и никуда не сохраняется: войти под роботом нельзя
  // ни нам, ни подрядчику. Он нужен только потому, что GoTrue требует его
  // при создании пользователя.
  password: randomBytes(32).toString('base64url'),
  user_metadata: { bench_robot: true, issued_for: name },
});
if (userError) {
  console.error('Не удалось создать робота:', userError.message);
  process.exit(1);
}
const robotId = created.user.id;

// role: null — робот не получает никакой роли в портале. Триггер на
// auth.users мог уже создать профиль с ролью по умолчанию, поэтому upsert
// перезаписывает её явно.
const { error: profileError } = await admin
  .from('profiles')
  .upsert({ id: robotId, email, role: null, is_api_robot: true }, { onConflict: 'id' });
if (profileError) {
  console.error('Не удалось завести профиль робота:', profileError.message);
  process.exit(1);
}

const key = `bench_live_${randomBytes(24).toString('base64url')}`;
const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');

const { error: keyError } = await admin.from('bench_api_keys').insert({
  name,
  key_hash: keyHash,
  key_last4: key.slice(-4),
  robot_user_id: robotId,
  allowed_tools: tools,
});
if (keyError) {
  console.error('Не удалось создать ключ:', keyError.message);
  process.exit(1);
}

console.log('Ключ выдан. Он показывается один раз — сохраните сейчас:\n');
console.log(`  ${key}\n`);
console.log(`  получатель:   ${name}`);
console.log(`  робот:        ${robotId}`);
console.log(`  инструменты:  ${tools.join(', ')}`);
