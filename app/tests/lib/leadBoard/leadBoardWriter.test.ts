/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient, type Row } from '@/../tests/helpers/mockSupabase';
import {
  resolveBoardProjectId,
  getOrCreateBoard,
  getBoardLinkForProject,
  upsertBoardRow,
  DEFAULT_COLUMN_CONFIG,
} from '@/lib/instantly/leadBoardWriter';

const PID = '11111111-2222-3333-4444-555555555555';
const PID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

type Db = Parameters<typeof resolveBoardProjectId>[0];

function makeDb(tables: Record<string, Row[]> = {}): MockSupabaseClient & Db {
  return createMockSupabase({ tables }) as unknown as MockSupabaseClient & Db;
}

beforeEach(() => {
  process.env.PORTAL_PUBLIC_URL = 'https://app.outreachos.pro';
  process.env.GUEST_TOKEN_SECRET = 'test-secret';
});

describe('resolveBoardProjectId', () => {
  it('один distinct project в period + legacy → возвращает его', async () => {
    const db = makeDb({
      project_period_instantly_campaigns: [{ project_id: PID, campaign_id: 'c1' }],
      project_instantly_campaigns: [{ project_id: PID, campaign_id: 'c1' }],
    });
    expect(await resolveBoardProjectId(db, 'c1')).toBe(PID);
  });

  it('разные project owners → null (fail closed, доску не выбираем)', async () => {
    const db = makeDb({
      project_period_instantly_campaigns: [{ project_id: PID, campaign_id: 'c1' }],
      project_instantly_campaigns: [{ project_id: PID2, campaign_id: 'c1' }],
    });
    expect(await resolveBoardProjectId(db, 'c1')).toBeNull();
  });

  it('ошибка любого link lookup → бросает, caller обязан прекратить side effects', async () => {
    const db = createMockSupabase({
      tables: {
        project_instantly_campaigns: [{ project_id: PID, campaign_id: 'c1' }],
      },
      errorTables: {
        project_period_instantly_campaigns: 'period links unavailable',
      },
    }) as unknown as Db;
    await expect(resolveBoardProjectId(db, 'c1')).rejects.toThrow('period links unavailable');
  });

  it('только легаси-ссылка → возвращает её', async () => {
    const db = makeDb({
      project_instantly_campaigns: [{ project_id: PID2, campaign_id: 'c1' }],
    });
    expect(await resolveBoardProjectId(db, 'c1')).toBe(PID2);
  });

  it('кампания без проекта → null', async () => {
    const db = makeDb();
    expect(await resolveBoardProjectId(db, 'c-unknown')).toBeNull();
  });
});

describe('getOrCreateBoard', () => {
  it('доски нет → создаёт с токеном и дефолтным конфигом', async () => {
    const db = makeDb({ project_lead_boards: [] });
    const board = await getOrCreateBoard(db, PID);

    expect(board.token.startsWith('lb_')).toBe(true);
    expect(board.columnConfig).toEqual(DEFAULT_COLUMN_CONFIG);
    const inserts = db.inserts.filter((i) => i.table === 'project_lead_boards');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].rows[0]).toMatchObject({ project_id: PID, token: board.token });
  });

  it('доска есть → возвращает существующий токен, insert не вызывается', async () => {
    const db = makeDb({
      project_lead_boards: [
        { project_id: PID, token: 'lb_stored.sig', column_config: [{ key: 'phone', visible: false }] },
      ],
    });
    const board = await getOrCreateBoard(db, PID);

    expect(board.token).toBe('lb_stored.sig');
    expect(board.columnConfig).toEqual([{ key: 'phone', visible: false }]);
    expect(db.inserts.filter((i) => i.table === 'project_lead_boards')).toHaveLength(0);
  });

  it('битый column_config → дефолтный', async () => {
    const db = makeDb({
      project_lead_boards: [{ project_id: PID, token: 'lb_stored.sig', column_config: 'oops' }],
    });
    const board = await getOrCreateBoard(db, PID);
    expect(board.columnConfig).toEqual(DEFAULT_COLUMN_CONFIG);
  });
});

describe('getBoardLinkForProject', () => {
  it('собирает публичную ссылку с токеном доски', async () => {
    const db = makeDb({
      project_lead_boards: [{ project_id: PID, token: 'lb_stored.sig', column_config: [] }],
    });
    const link = await getBoardLinkForProject(db, PID);
    expect(link).toBe('https://app.outreachos.pro/leads-board/lb_stored.sig');
  });

  it('проект без доски → создаёт и возвращает ссылку (ленивая провизия)', async () => {
    const db = makeDb({ project_lead_boards: [] });
    const link = await getBoardLinkForProject(db, PID);
    expect(link).toMatch(/^https:\/\/app\.outreachos\.pro\/leads-board\/lb_/);
  });

  it('сбой БД → null, НЕ бросает (ссылка не должна ронять алерт)', async () => {
    const broken = {} as Db; // db.from is not a function
    await expect(getBoardLinkForProject(broken, PID)).resolves.toBeNull();
  });
});

describe('upsertBoardRow', () => {
  it('пишет авто-поля с дедупом по qualification_id; клиентских колонок в payload НЕТ', async () => {
    const db = makeDb({ project_lead_board_rows: [] });
    await upsertBoardRow(db, {
      qualificationId: 'q-1',
      projectId: PID,
      campaignId: 'camp-1',
      campaignName: 'МКТ',
      leadEmail: 'lead@corp.ru',
      leadName: 'Иван',
      companyName: 'ООО Ромашка',
      phone: '+7 900 000-00-00',
      website: 'corp.ru',
      requestText: 'Давайте созвонимся',
      stepNumber: 2,
      replyTimestamp: '2026-07-26T10:00:00.000Z',
    });

    const upserts = db.upserts.filter((u) => u.table === 'project_lead_board_rows');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].onConflict).toBe('qualification_id');
    const row = upserts[0].rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      qualification_id: 'q-1',
      project_id: PID,
      lead_email: 'lead@corp.ru',
      step_number: 2,
    });
    // Клиентские колонки НИКОГДА не пишутся воркером (иначе затёр бы фидбэк).
    expect(row).not.toHaveProperty('quality');
    expect(row).not.toHaveProperty('comment');
    expect(row).not.toHaveProperty('taken');
  });
});
