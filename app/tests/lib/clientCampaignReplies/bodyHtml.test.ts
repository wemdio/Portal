import { textToReplyHtml } from '@/lib/clientCampaignReplies/bodyHtml';

describe('textToReplyHtml', () => {
  it('переводит \\n в <br> (сохранение переносов строк)', () => {
    expect(textToReplyHtml('строка1\nстрока2')).toBe('строка1<br>\nстрока2');
  });

  it('экранирует html-спецсимволы (& раньше < и >)', () => {
    expect(textToReplyHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('обрабатывает CRLF и одиночный CR', () => {
    expect(textToReplyHtml('a\r\nb\rc')).toBe('a<br>\nb<br>\nc');
  });

  it('многострочный абзац не схлопывается', () => {
    expect(textToReplyHtml('Здравствуйте!\n\nМы предлагаем X.\nС уважением.')).toBe(
      'Здравствуйте!<br>\n<br>\nМы предлагаем X.<br>\nС уважением.',
    );
  });

  it('пустая строка → пустая', () => {
    expect(textToReplyHtml('')).toBe('');
  });
});
