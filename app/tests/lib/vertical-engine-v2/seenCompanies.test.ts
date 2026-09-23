/** @jest-environment node */

import { buildVeSeenCompanies, veSeenCompanyCovers } from '@/lib/verticalEngineV2/seenCompanies';
import { normalizeVeSourceContacts } from '@/lib/verticalEngineV2/sourceContacts';

// Настоящие строки базы b5934955 «Промышленное производство» (аудит 22.09):
// партия №5 отправила «Крезол» сырым, партия №7 — обработанным, и отметки
// сравнивались как точные строки.
const row = (fields: Record<string, string>) => ({ company: '', inn: '', email: '', website: '', phone: '', vacancy_title: '',
  address: '', category: '', employees: '', revenue: '', source_detail: '', ...fields });
const KREZOL = row({ company: 'ООО "КРЕЗОЛ-НЕФТЕСЕРВИС"', inn: '0273094417', email: 'kns@krezol.ru, l.kuzmina@krezol.ru, df@krezol.ru',
  website: 'krezol-ns.ru', source_detail: 'реестр', address: '450027, г. Уфа, ул. Трамвайная' });

describe('VE2: компании, уже отправленные этой базой', () => {
  it('сырой и обработанный вариант одной строки — одна и та же компания', () => {
    const processed = normalizeVeSourceContacts(KREZOL);
    expect(processed).toMatchObject({ website: 'https://krezol-ns.ru/', source_detail: 'реестр\nСайт в источнике: krezol-ns.ru' });
    expect(veSeenCompanyCovers(buildVeSeenCompanies([KREZOL]), processed)).toBe(true);
    expect(veSeenCompanyCovers(buildVeSeenCompanies([processed]), KREZOL)).toBe(true);
    // Без ИНН компания узнаётся по названию вместе с сайтом, со схемой и без.
    const anonymous = { ...KREZOL, inn: '' };
    expect(veSeenCompanyCovers(buildVeSeenCompanies([anonymous]), normalizeVeSourceContacts(anonymous))).toBe(true);
  });

  it('старые отметки из четырёх полей читаются так же', () => {
    const legacy = { company: 'ООО "ХЭРГУ"', inn: '2825000414', email: 'amur-gold@mail.ru, callcentreblg@mail.ru', website: 'https://rosszoloto.ru/' };
    const seen = buildVeSeenCompanies([legacy, null, 'broken', []]);
    // Строка источника с третьим адресом, который занят: после вычёркивания нового нет.
    const source = row({ company: 'ООО "ХЭРГУ"', inn: '2825000414', website: 'rosszoloto.ru', source_detail: 'реестр',
      email: 'amur-gold@mail.ru, callcentreblg@mail.ru, rabota.rosszoloto@bk.ru' });
    expect(veSeenCompanyCovers(seen, source, ['amur-gold@mail.ru', 'callcentreblg@mail.ru'])).toBe(true);
    expect(veSeenCompanyCovers(seen, source)).toBe(false);
  });

  it('новый адрес или новый сайт — новая работа, а не повтор', () => {
    const seen = buildVeSeenCompanies([KREZOL]);
    expect(veSeenCompanyCovers(seen, { ...KREZOL, email: 'kns@krezol.ru, new@krezol.ru' })).toBe(false);
    expect(veSeenCompanyCovers(seen, { ...KREZOL, website: 'krezol-ns.ru, krezol.ru' })).toBe(false);
    // Строке без сайта и почты сайт нашёл добор — это новая работа по той же компании.
    const noSite = row({ company: 'Agency with missing site', inn: '7700000777', source_detail: 'реестр' });
    expect(veSeenCompanyCovers(buildVeSeenCompanies([noSite]), noSite)).toBe(true);
    expect(veSeenCompanyCovers(buildVeSeenCompanies([noSite]), { ...noSite, website: 'https://found.test/' })).toBe(false);
  });

  it('одно название без ИНН и сайта компанию не доказывает', () => {
    const cafe = row({ company: 'Кафе Уют', email: 'booking@uyut.test', address: 'Казань, ул. Баумана, 1' });
    expect(veSeenCompanyCovers(buildVeSeenCompanies([cafe]), cafe)).toBe(false);
    // Другое юрлицо с тем же названием и сайтом, но со своим ИНН — не повтор.
    const withInn = { ...KREZOL, inn: '' };
    expect(veSeenCompanyCovers(buildVeSeenCompanies([withInn]), { ...KREZOL, inn: '7700000001' })).toBe(false);
  });
});
