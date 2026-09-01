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
    const jobs = listAllBenchTools().filter((tool) => tool.kind === 'job');

    const checked: string[] = [];
    const mismatched: string[] = [];
    for (const tool of jobs) {
      const row = rows.find((line) => line.startsWith(`| ${tool.title} |`));
      if (!row) continue;
      checked.push(tool.title);
      const promised = row.trimEnd().endsWith('| да |');
      if (promised !== (tool as { stop: { supported: boolean } }).stop.supported) {
        mismatched.push(tool.title);
      }
    }

    // Без этой строки тест молча проходил бы вхолостую: поменяли вид таблицы —
    // строки перестали находиться, и «расхождений нет» означало бы «ничего не
    // проверено». Названия в таблице обязаны совпадать с названиями в реестре.
    expect(checked).toHaveLength(jobs.length);
    expect(mismatched).toEqual([]);
  });

  it('кнопки документации в админке ведут на существующие файлы', () => {
    // Иначе страница соберётся, тесты пройдут, а человек нажмёт и получит 404.
    const page = readFileSync(join(process.cwd(), 'src/app/admin/bench-keys/page.tsx'), 'utf8');
    const linked = [...page.matchAll(/href="(\/api-portal[a-z-]*\.md)"/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(0);
    const missing = linked.filter((href) => !existsSync(join(process.cwd(), 'public', href)));
    expect(missing).toEqual([]);
  });

  it('справочник ручек описывает каждую ручку витрины', () => {
    // Добавили роут и забыли описать — падает здесь.
    const doc = readFileSync(join(process.cwd(), 'public/api-portal-endpoints.md'), 'utf8');
    const routes = walk(BENCH_ROUTES)
      .filter((f) => f.endsWith('route.ts'))
      .map((f) =>
        f
          .replace(/\\/g, '/')
          .replace(/^.*\/api\/bench\/v1/, '')
          .replace(/\/route\.ts$/, '')
          .replace(/\[id\]/g, '{id}') || '/',
      );
    const undocumented = routes.filter((path) => !doc.includes(path));
    expect(undocumented).toEqual([]);
  });
});
