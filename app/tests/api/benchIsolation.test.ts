/** @jest-environment node */

import { readdirSync, readFileSync, statSync } from 'node:fs';
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
});
