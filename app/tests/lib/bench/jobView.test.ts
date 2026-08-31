/** @jest-environment node */

import { toBenchJobView } from '@/lib/bench/jobView';
import { yandexMapsTool } from '@/lib/bench/tools/yandexmaps';

describe('представление задачи', () => {
  it('приводит строку таблицы к общей форме', () => {
    const view = toBenchJobView(yandexMapsTool, {
      id: 'j1',
      status: 'running',
      processed_organizations: 118,
      total_organizations: 500,
      error_message: null,
      created_at: '2026-08-31T10:00:00Z',
      completed_at: null,
    });
    expect(view).toEqual({
      id: 'j1',
      tool: 'yandexmaps',
      status: 'running',
      progress: { done: 118, total: 500 },
      rows_found: 118,
      error: null,
      created_at: '2026-08-31T10:00:00Z',
      finished_at: null,
    });
  });

  it('не протаскивает наружу внутренние поля таблицы', () => {
    // Строка задачи несёт user_id, зашифрованные прокси и внутренний config.
    // Представление собирается перечислением полей, а не копированием строки,
    // — иначе любое новое внутреннее поле утекало бы наружу само собой.
    const view = toBenchJobView(yandexMapsTool, {
      id: 'j1',
      status: 'pending',
      user_id: 'secret-owner',
      proxy_credentials_encrypted: 'secret',
      config: { headless: true },
    });
    expect(Object.keys(view).sort()).toEqual([
      'created_at',
      'error',
      'finished_at',
      'id',
      'progress',
      'rows_found',
      'status',
      'tool',
    ]);
  });
});
