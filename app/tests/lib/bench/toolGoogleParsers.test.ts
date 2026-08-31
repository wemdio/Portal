/** @jest-environment node */

import { googleMapsTool, googleNewsTool } from '@/lib/bench/tools/googleParsers';

const OWNER = '00000000-0000-4000-8000-0000000000aa';

describe('адаптеры Google-парсеров', () => {
  it('принимают корректные параметры', () => {
    expect(
      googleMapsTool.paramsSchema.safeParse({ input_lines: ['кофейни Москва'] }).success,
    ).toBe(true);
    expect(
      googleNewsTool.paramsSchema.safeParse({ input_lines: ['госзакупки'] }).success,
    ).toBe(true);
  });

  it('требуют хотя бы один запрос', () => {
    expect(googleMapsTool.paramsSchema.safeParse({ input_lines: [] }).success).toBe(false);
  });

  it('не пропускают лишние поля', () => {
    expect(
      googleMapsTool.paramsSchema.safeParse({ input_lines: ['x'], user_id: OWNER }).success,
    ).toBe(false);
  });

  it('не дают задать задержки между запросами', () => {
    // Слишком малые задержки — прямой путь к капче и бану наших прокси,
    // а последствия несёт вся студия, а не автор скрипта.
    const parsed = googleMapsTool.paramsSchema.safeParse({
      input_lines: ['x'],
      minDelayMs: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('строят строку задачи с владельцем и безопасными задержками', () => {
    const params = googleMapsTool.paramsSchema.parse({ input_lines: ['кофейни', 'бары'] });
    const row = googleMapsTool.buildRow(params, OWNER) as {
      user_id: string;
      status: string;
      total_targets: number;
      proxy_enabled: boolean;
      config: Record<string, unknown>;
    };
    expect(row.user_id).toBe(OWNER);
    expect(row.status).toBe('queued');
    expect(row.total_targets).toBe(2);
    expect(row.proxy_enabled).toBe(false);
    expect(row.config.minDelayMs).toBe(1200);
    expect(row.config.maxDelayMs).toBe(2800);
  });

  it('News не обогащает контакты', () => {
    const params = googleNewsTool.paramsSchema.parse({ input_lines: ['x'] });
    const row = googleNewsTool.buildRow(params, OWNER) as { config: { enrichContacts: boolean } };
    expect(row.config.enrichContacts).toBe(false);
  });

  it('сворачивают богатый словарь статусов в общие пять', () => {
    expect(googleMapsTool.mapStatus({ status: 'queued' })).toBe('queued');
    expect(googleMapsTool.mapStatus({ status: 'running' })).toBe('running');
    expect(googleMapsTool.mapStatus({ status: 'paused' })).toBe('running');
    expect(googleMapsTool.mapStatus({ status: 'completed' })).toBe('done');
    expect(googleMapsTool.mapStatus({ status: 'stopped' })).toBe('stopped');
  });

  it('капча и блокировка — это провал, а не выполнено', () => {
    for (const status of ['captcha', 'blocked', 'timeout', 'login_required', 'failed']) {
      expect(googleMapsTool.mapStatus({ status })).toBe('failed');
    }
  });

  it('поддерживают настоящую остановку', () => {
    expect(googleMapsTool.stop).toEqual({ supported: true, stoppedStatus: 'stopped' });
    expect(googleNewsTool.stop).toEqual({ supported: true, stoppedStatus: 'stopped' });
  });

  it('отдают прогресс и диагностику', () => {
    const row = { processed_targets: 3, total_targets: 10, total_results: 57, message: 'captcha' };
    expect(googleMapsTool.progress(row)).toEqual({ done: 3, total: 10 });
    expect(googleMapsTool.rowsFound(row)).toBe(57);
    expect(googleMapsTool.errorOf(row)).toBe('captcha');
  });

  it('авария важнее диагностики', () => {
    expect(googleMapsTool.errorOf({ error_message: 'сервис недоступен', message: 'captcha' })).toBe(
      'сервис недоступен',
    );
  });

  it('результаты лежат в отдельных таблицах', () => {
    expect(googleMapsTool.results).toMatchObject({ kind: 'table', table: 'google_maps_places' });
    expect(googleNewsTool.results).toMatchObject({ kind: 'table', table: 'google_news_results' });
  });
});
