/** @jest-environment jsdom */

import {
  deletePendingDbImport,
  listPendingDbImports,
  readPendingDbImport,
  writePendingDbImport,
} from '@/lib/databases/pendingImport';

const QUEUE_KEY = 'portal:db-import:queue:v1';

describe('pending db import queue', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('регистрирует импорт в очереди, чтобы «Базы» подобрали его без ссылки в тосте', async () => {
    const { id } = await writePendingDbImport({
      title: 'Вакансии #abc12345',
      rows: [['company', 'url'], ['Альфа', 'https://a.ru']],
    });

    const queue = listPendingDbImports();
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(id);
    expect(queue[0].title).toBe('Вакансии #abc12345');
    expect(queue[0].rows).toBe(2);

    const payload = await readPendingDbImport(id);
    expect(payload?.rows).toHaveLength(2);
  });

  it('убирает импорт из очереди после потребления', async () => {
    const { id } = await writePendingDbImport({ title: 'A', rows: [['x']] });
    await deletePendingDbImport(id);

    expect(listPendingDbImports()).toHaveLength(0);
    expect(await readPendingDbImport(id)).toBeNull();
  });

  it('отдаёт импорты в порядке добавления', async () => {
    const first = await writePendingDbImport({ title: 'First', rows: [['1']] });
    const second = await writePendingDbImport({ title: 'Second', rows: [['2']] });

    expect(listPendingDbImports().map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it('не подбирает протухшие импорты и вычищает их из очереди', async () => {
    const { id } = await writePendingDbImport({ title: 'Old', rows: [['1']] });
    const stale = JSON.parse(window.localStorage.getItem(QUEUE_KEY) ?? '{}') as {
      entries: Array<{ id: string; created_at: string }>;
    };
    stale.entries[0].created_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(stale));

    expect(listPendingDbImports()).toHaveLength(0);
    expect(window.localStorage.getItem(QUEUE_KEY)).not.toContain(id);
  });

  it('переживает мусор в ключе очереди', () => {
    window.localStorage.setItem(QUEUE_KEY, 'not-json');
    expect(listPendingDbImports()).toEqual([]);
  });
});
