/** @jest-environment node */

const upload = jest.fn(async (_p: string, _b: Buffer, _o: unknown) => ({ error: null as null | { message: string } }));
const remove = jest.fn(async (_paths: string[]) => ({ error: null }));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: (p: string, b: Buffer, o: unknown) => upload(p, b, o),
        remove: (paths: string[]) => remove(paths),
      }),
    },
  },
}));

import { innEnrichTool } from '@/lib/bench/tools/innEnrich';

const OWNER = '00000000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  upload.mockClear();
  remove.mockClear();
  upload.mockResolvedValue({ error: null });
});

describe('адаптер обогащения по ИНН', () => {
  it('принимает список ИНН вместо файла', () => {
    expect(
      innEnrichTool.paramsSchema.safeParse({ inns: ['7700000001', '770000000102'] }).success,
    ).toBe(true);
  });

  it('отвергает то, что не похоже на ИНН', () => {
    expect(innEnrichTool.paramsSchema.safeParse({ inns: ['абв'] }).success).toBe(false);
    expect(innEnrichTool.paramsSchema.safeParse({ inns: ['12345'] }).success).toBe(false);
  });

  it('требует хотя бы один ИНН', () => {
    expect(innEnrichTool.paramsSchema.safeParse({ inns: [] }).success).toBe(false);
  });

  it('складывает список в CSV и кладёт в хранилище', async () => {
    const params = innEnrichTool.paramsSchema.parse({ inns: ['7700000001', '7700000002'] });
    const prepared = await innEnrichTool.prepare!({ params, ownerId: OWNER });

    expect(upload).toHaveBeenCalledTimes(1);
    const [path, body] = upload.mock.calls[0];
    expect(path).toBe(`${prepared.id}/source.csv`);
    // Заголовок обязателен: задача создаётся с has_header=true, и без него
    // первый ИНН был бы съеден как название колонки.
    expect(body.toString('utf8')).toBe('inn\n7700000001\n7700000002');
    expect(prepared.total).toBe(2);
  });

  it('сбой загрузки не создаёт задачу', async () => {
    upload.mockResolvedValueOnce({ error: { message: 'диск переполнен' } });
    const params = innEnrichTool.paramsSchema.parse({ inns: ['7700000001'] });
    await expect(innEnrichTool.prepare!({ params, ownerId: OWNER })).rejects.toThrow(
      'диск переполнен',
    );
  });

  it('откат убирает файл несостоявшейся задачи', async () => {
    await innEnrichTool.rollback!({ source_path: 'abc/source.csv' });
    expect(remove).toHaveBeenCalledWith(['abc/source.csv']);
  });

  it('откат без пути ничего не удаляет', async () => {
    await innEnrichTool.rollback!({});
    expect(remove).not.toHaveBeenCalled();
  });

  it('строка задачи выглядит как загруженная человеком', () => {
    const params = innEnrichTool.paramsSchema.parse({ inns: ['7700000001'] });
    const row = innEnrichTool.buildRow(params, OWNER);
    expect(row.user_id).toBe(OWNER);
    expect(row.has_header).toBe(true);
    expect(row.column_index).toBe(0);
  });

  it('результат отдаётся файлом, а не строками', () => {
    // Иначе наружу под видом результата ушла бы статистика.
    expect(innEnrichTool.results).toMatchObject({ kind: 'file', pathField: 'result_path' });
  });

  it('остановки не поддерживает и говорит об этом', () => {
    expect(innEnrichTool.stop.supported).toBe(false);
  });
});
