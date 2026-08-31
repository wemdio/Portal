/** @jest-environment node */

import { yandexMapsTool } from '@/lib/bench/tools/yandexmaps';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const URL = 'https://yandex.ru/maps/?text=кофейни';

describe('адаптер yandexmaps', () => {
  it('принимает корректные параметры', () => {
    expect(
      yandexMapsTool.paramsSchema.safeParse({ search_urls: [URL], max_results: 500 }).success,
    ).toBe(true);
  });

  it('требует хотя бы одну ссылку', () => {
    expect(yandexMapsTool.paramsSchema.safeParse({ search_urls: [] }).success).toBe(false);
  });

  it('не пропускает лишние поля', () => {
    expect(
      yandexMapsTool.paramsSchema.safeParse({ search_urls: [URL], user_id: OWNER }).success,
    ).toBe(false);
  });

  it('строит строку задачи с владельцем и статусом pending', () => {
    const params = yandexMapsTool.paramsSchema.parse({ search_urls: [URL], max_results: 500 });
    const row = yandexMapsTool.buildRow(params, OWNER);
    expect(row.user_id).toBe(OWNER);
    expect(row.status).toBe('pending');
    expect(row.config).toEqual({
      search_urls: [URL],
      catalog_filters: null,
      max_results: 500,
      headless: true,
    });
  });

  it('переводит внутренние статусы в общий словарь', () => {
    expect(yandexMapsTool.mapStatus({ status: 'pending' })).toBe('queued');
    expect(yandexMapsTool.mapStatus({ status: 'running' })).toBe('running');
    expect(yandexMapsTool.mapStatus({ status: 'completed' })).toBe('done');
    expect(yandexMapsTool.mapStatus({ status: 'failed' })).toBe('failed');
  });

  it('честно сообщает, что остановки у него нет', () => {
    expect(yandexMapsTool.stop.supported).toBe(false);
  });

  it('отдаёт прогресс и число найденных строк', () => {
    const row = { processed_organizations: 118, total_organizations: 500 };
    expect(yandexMapsTool.progress(row)).toEqual({ done: 118, total: 500 });
    expect(yandexMapsTool.rowsFound(row)).toBe(118);
  });

  it('total = null, пока воркер не знает объёма', () => {
    expect(yandexMapsTool.progress({ total_organizations: 0 }).total).toBeNull();
  });

  it('отдаёт причину падения и время завершения', () => {
    expect(yandexMapsTool.errorOf({ error_message: 'прокси недоступны' })).toBe('прокси недоступны');
    expect(yandexMapsTool.errorOf({ error_message: null })).toBeNull();
    expect(yandexMapsTool.finishedAt({ completed_at: '2026-08-31T10:00:00Z' })).toBe(
      '2026-08-31T10:00:00Z',
    );
    expect(yandexMapsTool.finishedAt({ completed_at: null })).toBeNull();
  });
});
