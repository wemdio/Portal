/** @jest-environment node */

/**
 * Порядок обработки кандидатов внутри партии. Ничего не отклоняет — только
 * решает, кого движок возьмёт первым, а значит на кого потратит обход сайта и
 * очередь SMTP-проверки раньше остальных.
 */
import { prioritizeVeCandidates } from '@/lib/verticalEngineV2/candidatePriority';

const row = (over: Partial<Record<'company' | 'inn' | 'website' | 'address' | 'email' | 'category', string>>) => ({
  company: 'Компания', inn: '', website: '', address: '', email: '', category: 'производство мебели', ...over,
});

describe('prioritizeVeCandidates', () => {
  it('ставит компанию с готовым адресом впереди компании, у которой есть только сайт', () => {
    // Контакт из готового адреса не требует ни обхода сайта, ни SMTP-очереди,
    // поэтому он должен обрабатываться раньше. До правки сайт весил 30, а
    // почта 5, и такие компании уезжали в хвост партии.
    const withEmail = row({ company: 'С почтой', email: 'info@romashka.ru' });
    const withSite = row({ company: 'С сайтом', website: 'https://romashka.ru' });
    expect(prioritizeVeCandidates([withSite, withEmail]).map((item) => item.company))
      .toEqual(['С почтой', 'С сайтом']);
  });

  it('компания и с адресом, и с сайтом идёт раньше любой из них по отдельности', () => {
    const both = row({ company: 'И то и то', email: 'a@b.ru', website: 'https://b.ru' });
    const onlyEmail = row({ company: 'Только почта', email: 'c@d.ru' });
    const onlySite = row({ company: 'Только сайт', website: 'https://e.ru' });
    expect(prioritizeVeCandidates([onlySite, onlyEmail, both]).map((item) => item.company))
      .toEqual(['И то и то', 'Только почта', 'Только сайт']);
  });

  it('никого не выбрасывает и сохраняет порядок при равных баллах', () => {
    const rows = [row({ company: 'Первая' }), row({ company: 'Вторая' }), row({ company: 'Третья' })];
    expect(prioritizeVeCandidates(rows).map((item) => item.company)).toEqual(['Первая', 'Вторая', 'Третья']);
    // preserveOrder=true отключает сортировку целиком — набор всё равно полный.
    expect(prioritizeVeCandidates(rows, [], '', Date.now(), true)).toHaveLength(3);
  });
});
