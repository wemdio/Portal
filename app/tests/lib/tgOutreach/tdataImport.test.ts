/**
 * @jest-environment node
 */
import {
  collectTdataCandidates,
  TDESKTOP_API_ID,
  TDESKTOP_API_HASH,
  type TdataArchiveReader,
} from '@/lib/tgOutreach/tdataImport';

const reader: TdataArchiveReader = async (_buffer, archiveName) => {
  if (archiveName === 'битый.zip') throw new Error('в архиве не найдена папка tdata');
  if (archiveName === 'частично-битый.zip') {
    return [
      { name: 'ok_acc', accounts: [{ index: 0, tgUserId: 42, sessionString: 'sess-42' }] },
      { name: 'bad_acc', accounts: [], error: 'папка под локальным паролем Telegram либо повреждена' },
    ];
  }
  if (archiveName === 'мульти.zip') {
    return [{
      name: 'multi',
      accounts: [
        { index: 0, tgUserId: 11, sessionString: 'sess-11' },
        { index: 1, tgUserId: 22, sessionString: 'sess-22' },
      ],
    }];
  }
  return [{
    name: archiveName.replace(/\.zip$/, ''),
    accounts: [{ index: 0, tgUserId: 777, sessionString: 'sess-777' }],
  }];
};

const file = (name: string) => ({ name, buffer: Buffer.alloc(0) });

describe('collectTdataCandidates', () => {
  it('собирает кандидата с телеграмовскими api_id и api_hash', async () => {
    const result = await collectTdataCandidates([file('246630983.zip')], reader);

    expect(result.errors).toEqual([]);
    expect(result.candidates).toEqual([{
      name: '246630983',
      tgUserId: 777,
      sessionString: 'sess-777',
      apiId: TDESKTOP_API_ID,
      apiHash: TDESKTOP_API_HASH,
    }]);
  });

  it('нумерует аккаунты внутри мультиаккаунтной папки', async () => {
    const result = await collectTdataCandidates([file('мульти.zip')], reader);

    expect(result.candidates.map((c) => c.name)).toEqual(['multi', 'multi_2']);
  });

  it('отсекает один и тот же аккаунт, залитый двумя архивами', async () => {
    const result = await collectTdataCandidates(
      [file('копия1.zip'), file('копия2.zip')],
      reader,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.skipped).toEqual([
      { name: 'копия2', reason: 'этот же аккаунт уже есть в загрузке (копия1)' },
    ]);
  });

  it('битый архив не отменяет остальные', async () => {
    const result = await collectTdataCandidates(
      [file('битый.zip'), file('живой.zip')],
      reader,
    );

    expect(result.candidates.map((c) => c.name)).toEqual(['живой']);
    expect(result.errors).toEqual([
      { name: 'битый.zip', error: 'в архиве не найдена папка tdata' },
    ]);
  });

  it('битая папка внутри архива не отменяет соседние', async () => {
    const result = await collectTdataCandidates([file('частично-битый.zip')], reader);

    expect(result.candidates.map((c) => c.name)).toEqual(['ok_acc']);
    expect(result.errors).toEqual([
      { name: 'bad_acc', error: 'папка под локальным паролем Telegram либо повреждена' },
    ]);
  });
});
