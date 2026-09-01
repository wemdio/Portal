/** @jest-environment node */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { listAllBenchTools } from '@/lib/bench/registry';
import { join } from 'node:path';

const BENCH_ROUTES = join(process.cwd(), 'src/app/api/bench');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Сторож изоляции. Проверки статические — они стерегут не поведение одного
 * роута, а свойство всего раздела: сколько бы адаптеров и роутов сюда ни
 * добавили потом, обойти изоляцию, лимиты или журнал молча не получится.
 */
describe('изоляция витрины', () => {
  const files = walk(BENCH_ROUTES).filter((f) => f.endsWith('.ts'));
  const read = (f: string) => readFileSync(f, 'utf8');

  it('роуты витрины существуют', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('ни один роут не ходит в данные сервисным ключом', () => {
    // supabaseAdmin обходит RLS. Роуты обязаны работать через клиент робота
    // (auth.db) — иначе изоляцию сторожит только наш код, а не база.
    expect(files.filter((f) => read(f).includes('supabaseAdmin'))).toEqual([]);
  });

  it('ни один роут не собирает клиент в обход createBenchDb', () => {
    expect(files.filter((f) => read(f).includes('createAuthedSupabaseClient'))).toEqual([]);
  });

  it('владелец задачи нигде не берётся из тела запроса', () => {
    expect(files.filter((f) => /body\.\w*user_id/.test(read(f)))).toEqual([]);
  });

  it('каждый роут проверяет ключ', () => {
    expect(files.filter((f) => !read(f).includes('authenticateBench'))).toEqual([]);
  });

  it('каждый роут проверяет лимиты', () => {
    expect(files.filter((f) => !read(f).includes('checkBenchLimits'))).toEqual([]);
  });

  it('каждый роут пишет в журнал', () => {
    expect(files.filter((f) => !read(f).includes('logBenchRequest'))).toEqual([]);
  });

  it('удаления в витрине не существует как действия', () => {
    // Не «запрещено настройкой» — такого глагола в разделе просто нет.
    expect(files.filter((f) => /export async function DELETE/.test(read(f)))).toEqual([]);
    expect(files.filter((f) => /\.delete\(\)/.test(read(f)))).toEqual([]);
  });

  it('документация знает про каждый инструмент реестра', () => {
    // Добавили адаптер и забыли документацию — падает здесь. `GET /tools`
    // расскажет о новом инструменте сам, но человек, которому дали ключ,
    // читает сначала файл.
    const doc = readFileSync(join(process.cwd(), 'public/api-portal.md'), 'utf8');
    const undocumented = listAllBenchTools()
      .map((tool) => tool.id)
      .filter((id) => !doc.includes(`\`${id}\``));
    expect(undocumented).toEqual([]);
  });

  it('документация не обещает остановку там, где её нет', () => {
    const doc = readFileSync(join(process.cwd(), 'public/api-portal.md'), 'utf8');
    const rows = doc.split('\n');
    const mismatched = listAllBenchTools()
      .filter((tool) => tool.kind === 'job')
      .filter((tool) => {
        const row = rows.find((line) => line.startsWith(`| \`${tool.id}\``));
        if (!row) return false;
        const promised = row.trimEnd().endsWith('| да |');
        return promised !== (tool as { stop: { supported: boolean } }).stop.supported;
      })
      .map((tool) => tool.id);
    expect(mismatched).toEqual([]);
  });

  it('кнопка «Скачать» в админке ведёт на существующий файл', () => {
    // Иначе страница соберётся, тесты пройдут, а человек нажмёт и получит 404.
    const page = readFileSync(join(process.cwd(), 'src/app/admin/bench-keys/page.tsx'), 'utf8');
    expect(page).toContain('href="/api-portal.md"');
    expect(existsSync(join(process.cwd(), 'public/api-portal.md'))).toBe(true);
  });
});
