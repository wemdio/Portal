import {
  buildQuoteHeader,
  appendQuotedHistoryText,
  appendQuotedHistoryHtml,
} from '@/lib/clientCampaignReplies/quoteHistory';

const SRC = {
  bodyText: 'Здравствуйте!\nИнтересует цена.',
  fromName: 'Клиент Иван',
  fromEmail: 'ivan@co.com',
  timestamp: '2026-07-09T09:00:00.000Z',
};

describe('buildQuoteHeader', () => {
  it('«дата, имя писал(а):» — имя приоритетнее email', () => {
    const h = buildQuoteHeader(SRC);
    expect(h).toContain('Клиент Иван');
    expect(h).toMatch(/писал\(а\):$/);
    expect(h).not.toContain('ivan@co.com');
  });

  it('без имени — берёт email; без обоих — «Отправитель»', () => {
    expect(buildQuoteHeader({ bodyText: 'x', fromEmail: 'a@b.com' })).toContain('a@b.com');
    expect(buildQuoteHeader({ bodyText: 'x' })).toContain('Отправитель');
  });

  it('битый timestamp не роняет заголовок (просто без даты)', () => {
    const h = buildQuoteHeader({ bodyText: 'x', fromName: ' N', timestamp: 'not-a-date' });
    expect(h).toBe('N писал(а):');
  });
});

describe('appendQuotedHistoryText', () => {
  it('дописывает историю с префиксом «> » по строкам', () => {
    const out = appendQuotedHistoryText('Мой ответ.', SRC);
    expect(out).toContain('Мой ответ.');
    expect(out).toContain('> Здравствуйте!');
    expect(out).toContain('> Интересует цена.');
    // ответ идёт ПЕРЕД цитатой
    expect(out.indexOf('Мой ответ.')).toBeLessThan(out.indexOf('> Здравствуйте!'));
  });

  it('пустая история → возвращает ответ как есть (без хвоста)', () => {
    expect(appendQuotedHistoryText('Ответ', { bodyText: '   ' })).toBe('Ответ');
    expect(appendQuotedHistoryText('Ответ', { bodyText: null })).toBe('Ответ');
  });
});

describe('appendQuotedHistoryHtml', () => {
  it('оборачивает историю в blockquote, экранирует HTML, переносы → <br>', () => {
    const out = appendQuotedHistoryHtml('<b>Ответ</b>', {
      bodyText: 'Строка 1\nСтрока <2>',
      fromName: 'N',
    });
    expect(out).toContain('<b>Ответ</b>');
    expect(out).toContain('<blockquote');
    expect(out).toContain('Строка 1<br>');
    // спецсимволы тела экранированы
    expect(out).toContain('Строка &lt;2&gt;');
    expect(out).not.toContain('Строка <2>');
  });

  it('пустая история → возвращает html как есть', () => {
    expect(appendQuotedHistoryHtml('<b>x</b>', { bodyText: '' })).toBe('<b>x</b>');
  });

  it('АБЗАЦЫ И СПЕЙСИНГ сохраняются: пустая строка между абзацами → <br><br> (не «простыня»)', () => {
    const html = appendQuotedHistoryHtml('Ответ', { bodyText: 'Абзац 1.\n\nАбзац 2.', fromName: 'N' });
    // каждый перенос стал <br>; двойной перенос (абзацный отступ) = два <br>
    expect(html).toContain('Абзац 1.<br>\n<br>\nАбзац 2.');
    // текст НЕ схлопнут в одну строку
    expect(html).not.toContain('Абзац 1. Абзац 2.');
    expect(html).not.toContain('Абзац 1.Абзац 2.');
  });

  it('АБЗАЦЫ в text-фолбэке: пустая строка цитируется как «> » (отступ сохранён)', () => {
    const text = appendQuotedHistoryText('Ответ', { bodyText: 'Абзац 1.\n\nАбзац 2.' });
    expect(text).toContain('> Абзац 1.\n> \n> Абзац 2.');
  });
});
