/** @jest-environment node */

/**
 * Инцидент 19.08.2026: три из четырёх аккаунтов парсера оказались теми же
 * номерами, что работали в аутрич-кампании TG_VBI. Каждый запуск парсера падал
 * с `406: AUTH_KEY_DUPLICATED` за доли секунды, а у четвёртого номера сессию
 * этим же способом сожгло раньше — его пришлось переавторизовывать.
 */

import {
  findOutreachConflict,
  normalizePhone,
  outreachConflictMessage,
} from '@/lib/tgParser/accountConflict';

/** Реальные номера из инцидента. */
const BUSY = [
  { phone: '375338879881', campaignName: 'TG_VBI' },
  { phone: '77758374922', campaignName: 'TG_VBI' },
  { phone: '998990297461', campaignName: 'TG_VBI' },
];

describe('findOutreachConflict', () => {
  it('ловит номер, занятый работающей кампанией', () => {
    expect(findOutreachConflict('77758374922', BUSY)).toBe('TG_VBI');
  });

  it('пропускает номер, которого в аутриче нет', () => {
    // 77789096058 — четвёртый аккаунт парсера, в аутриче не числится.
    expect(findOutreachConflict('77789096058', BUSY)).toBeNull();
  });

  it('сравнивает по цифрам: форматы записи в двух таблицах разные', () => {
    expect(findOutreachConflict('+7 775 837-49-22', BUSY)).toBe('TG_VBI');
    expect(findOutreachConflict('77758374922', [{ phone: '+7 (775) 837-49-22', campaignName: 'TG_VBI' }]))
      .toBe('TG_VBI');
  });

  it('пустой или отсутствующий номер конфликтом не считает', () => {
    expect(findOutreachConflict(null, BUSY)).toBeNull();
    expect(findOutreachConflict('', BUSY)).toBeNull();
    expect(findOutreachConflict('—', BUSY)).toBeNull();
  });

  it('не спотыкается на аутрич-аккаунтах без телефона', () => {
    expect(findOutreachConflict('77758374922', [{ phone: null, campaignName: 'TG_VBI' }])).toBeNull();
  });

  it('возвращает имя той кампании, которая реально держит номер', () => {
    const many = [
      { phone: '111', campaignName: 'Первая' },
      { phone: '77758374922', campaignName: 'TG_VBI' },
      { phone: '222', campaignName: 'Третья' },
    ];
    expect(findOutreachConflict('77758374922', many)).toBe('TG_VBI');
  });
});

describe('normalizePhone', () => {
  it('оставляет только цифры', () => {
    expect(normalizePhone('+7 (775) 837-49-22')).toBe('77758374922');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('outreachConflictMessage', () => {
  it('называет номер, кампанию и что делать', () => {
    const msg = outreachConflictMessage('77758374922', 'TG_VBI');
    expect(msg).toContain('77758374922');
    expect(msg).toContain('TG_VBI');
    expect(msg).toContain('отдельный номер');
  });
});
