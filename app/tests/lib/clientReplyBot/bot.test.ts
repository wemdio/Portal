/** @jest-environment node */

import { buildClientReplyMessage } from '@/lib/clientReplyBot/bot';

describe('buildClientReplyMessage — бейдж «свой промпт»', () => {
  const base = {
    campaignName: 'Кампания клиента',
    leadEmail: 'lead@example.com',
    leadName: 'Иван',
    companyName: 'ООО Пример',
    replySubject: 'Re: предложение',
    replyBody: 'Интересно, пришлите цены.',
    replyTimestamp: '2026-07-14T10:00:00Z',
  };

  it('лид по клиентским критериям → заголовок «🔥 Лид по вашим критериям»', () => {
    const html = buildClientReplyMessage({ ...base, isLeadByClientCriteria: true });
    expect(html).toContain('🔥 <b>Лид по вашим критериям</b>');
    expect(html).not.toContain('Новый ответ по вашей кампании');
  });

  it('обычный ответ → прежний заголовок, без бейджа', () => {
    const html = buildClientReplyMessage({ ...base, isLeadByClientCriteria: false });
    expect(html).toContain('📩 <b>Новый ответ по вашей кампании</b>');
    expect(html).not.toContain('по вашим критериям');
  });
});
