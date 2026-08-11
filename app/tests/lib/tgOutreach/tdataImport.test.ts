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
  // Продавец разложил партию по лотам: `лот1/acc/tdata` и `лот2/acc/tdata`.
  // Слой архива честно отдаёт две папки с одним именем — развести их может
  // только эта сборка.
  if (archiveName === 'два-лота.zip') {
    return [
      { name: 'acc', accounts: [{ index: 0, tgUserId: 51, sessionString: 'sess-51' }] },
      { name: 'acc', accounts: [{ index: 0, tgUserId: 52, sessionString: 'sess-52' }] },
    ];
  }
  // Папка `acc` на два аккаунта даёт `acc_2`, и рядом лежит папка, которую
  // продавец и правда назвал `acc_2`.
  if (archiveName === 'сосед.zip') {
    return [
      {
        name: 'acc',
        accounts: [
          { index: 0, tgUserId: 61, sessionString: 'sess-61' },
          { index: 1, tgUserId: 62, sessionString: 'sess-62' },
        ],
      },
      { name: 'acc_2', accounts: [{ index: 0, tgUserId: 63, sessionString: 'sess-63' }] },
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

  it('разводит папки, которые пришли из архива под одним именем', async () => {
    const result = await collectTdataCandidates([file('два-лота.zip')], reader);

    // Имя — единственное, чем оператор различает свежие tdata-строки: телефон
    // пуст, а имя пользователя неизвестно до «Проверить».
    expect(result.candidates.map((c) => c.name)).toEqual(['acc', 'acc_2']);
  });

  it('разводит имя папки и номер аккаунта, если они совпали', async () => {
    const result = await collectTdataCandidates([file('сосед.zip')], reader);

    expect(result.candidates.map((c) => c.name)).toEqual(['acc', 'acc_2', 'acc_2_2']);
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
