import { parseInnColumn, splitCsvLine } from '@/lib/companiesSearch/innCsv';

describe('splitCsvLine', () => {
  it('простые значения через запятую', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('кавычки: запятая и экранированная кавычка внутри значения', () => {
    expect(splitCsvLine('"ООО ""Рога, копыта""",7701234567')).toEqual(['ООО "Рога, копыта"', '7701234567']);
  });

  it('пустые ячейки сохраняются', () => {
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseInnColumn', () => {
  it('находит колонку «ИНН» по заголовку (формат нашей выгрузки)', () => {
    const csv = [
      'Название,ИНН,КПП,Адрес',
      '"ООО Ромашка",7701234567,770101001,"Москва, ул. Ленина"',
      '"ИП Иванов",770123456789,,"СПб"',
    ].join('\n');
    expect(parseInnColumn(csv).sort()).toEqual(['7701234567', '770123456789']);
  });

  it('дедуплицирует повторы и отбрасывает мусор (не 10/12 цифр)', () => {
    const csv = [
      'Название,ИНН',
      'А,7701234567',
      'Б,7701234567',
      'В,123',
      'Г,abc',
    ].join('\n');
    expect(parseInnColumn(csv)).toEqual(['7701234567']);
  });

  it('fallback без заголовка «ИНН»: берёт ячейки, похожие на ИНН', () => {
    const csv = [
      'name,tax_id',
      'ООО Х,5401234567',
    ].join('\n');
    expect(parseInnColumn(csv)).toEqual(['5401234567']);
  });

  it('телефоны/ОГРН не путает с ИНН (11 и 13 цифр не проходят)', () => {
    const csv = [
      'Название,Телефоны,ОГРН',
      'А,79001234567,1027700132195',
    ].join('\n');
    expect(parseInnColumn(csv)).toEqual([]);
  });

  it('CRLF и пустые строки не ломают парсинг', () => {
    const csv = 'ИНН\r\n7701234567\r\n\r\n';
    expect(parseInnColumn(csv)).toEqual(['7701234567']);
  });

  it('пустой файл → []', () => {
    expect(parseInnColumn('')).toEqual([]);
  });
});
