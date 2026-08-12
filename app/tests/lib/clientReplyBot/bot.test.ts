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

/**
 * Регрессия на инцидент 16.07.2026: воркер крутится в контейнере с TZ=UTC, и
 * toLocale* БЕЗ явного timeZone рендерил время ответа на 3 часа раньше
 * московского — спец получила «09:52» на письмо, пришедшее в 12:52 МСК.
 * Тесты TZ-независимы (пояс задан явно), поэтому ловят регресс на любой машине.
 */
describe('buildClientReplyMessage — время всегда в МСК', () => {
  const base = {
    campaignName: 'OutreachOS Автоаутрич 1',
    leadEmail: 'mail@ii24.site',
    leadName: null,
    companyName: 'ИИ24',
    replySubject: 'Re: к кому по новым клиентам?',
    replyBody: 'Давайте завтра в 10:00.',
  };

  it('UTC-метка конвертируется в московское время и подписана «(МСК)»', () => {
    // Реальный ответ из инцидента: 09:52 UTC = 12:52 МСК.
    const html = buildClientReplyMessage({ ...base, replyTimestamp: '2026-07-16T09:52:36+00:00' });
    expect(html).toContain('12:52');
    expect(html).toContain('(МСК)');
    expect(html).not.toContain('09:52');
  });

  it('у полуночи берёт московскую дату, а не UTC-дату', () => {
    // 22:30 UTC 16-го = 01:30 МСК 17-го → дата должна быть 17 июля.
    const html = buildClientReplyMessage({ ...base, replyTimestamp: '2026-07-16T22:30:00+00:00' });
    expect(html).toContain('17 июля');
    expect(html).not.toContain('16 июля');
  });

  it('битая метка не роняет сборку сообщения', () => {
    const html = buildClientReplyMessage({ ...base, replyTimestamp: 'не-дата' });
    expect(html).toContain('mail@ii24.site');
    expect(html).not.toContain('Invalid Date');
  });
});

/**
 * Сироты (инцидент 11.08.2026): Instantly НЕ привязал письмо к кампании —
 * DM не должен говорить «по вашей кампании» (это отправляло клиента искать
 * ответ в кампании, где его нет и быть не может).
 */
describe('buildClientReplyMessage — сирота (ответ вне треда кампании)', () => {
  const base = {
    campaignName: 'OutreachOS Автоаутрич 2',
    leadEmail: 'director@leadscorp.ru',
    leadName: 'Ольга',
    companyName: 'Лидскорп',
    replySubject: 'Re: По вопросу клиентов',
    replyBody: 'Давайте обсудим, удобно завтра.',
    replyTimestamp: '2026-08-11T09:00:00Z',
  };

  it('outOfCampaign=true → честный заголовок + ящик + «похоже на лид кампании»', () => {
    const html = buildClientReplyMessage({
      ...base,
      outOfCampaign: true,
      eaccount: 'sales@clientmail.ru',
    });
    expect(html).toContain('📩 <b>Ответ вне треда кампании</b>');
    expect(html).not.toContain('Новый ответ по вашей кампании');
    expect(html).toContain('📬 <b>Ящик:</b> sales@clientmail.ru');
    // Кампания остаётся как контекст атрибуции, а не как факт привязки.
    expect(html).toContain('🔎 <b>Похоже на лид кампании:</b> OutreachOS Автоаутрич 2');
    expect(html).not.toContain('📨 <b>Кампания:</b>');
  });

  it('outOfCampaign=false → прежний формат (заголовок, кампания, без ящика)', () => {
    const html = buildClientReplyMessage({
      ...base,
      outOfCampaign: false,
      eaccount: 'sales@clientmail.ru',
    });
    expect(html).toContain('📩 <b>Новый ответ по вашей кампании</b>');
    expect(html).toContain('📨 <b>Кампания:</b> OutreachOS Автоаутрич 2');
    expect(html).not.toContain('Ящик:');
    expect(html).not.toContain('Похоже на лид кампании');
  });

  it('outOfCampaign без eaccount → строки «Ящик:» нет', () => {
    const html = buildClientReplyMessage({ ...base, outOfCampaign: true, eaccount: null });
    expect(html).toContain('📩 <b>Ответ вне треда кампании</b>');
    expect(html).not.toContain('Ящик:');
  });

  it('outOfCampaign + лид по критериям клиента → заголовок сироты, бейдж сохранён', () => {
    const html = buildClientReplyMessage({
      ...base,
      outOfCampaign: true,
      eaccount: 'sales@clientmail.ru',
      isLeadByClientCriteria: true,
    });
    expect(html).toContain('📩 <b>Ответ вне треда кампании</b>');
    expect(html).toContain('🔥 <b>Лид по вашим критериям</b>');
    expect(html).not.toContain('Новый ответ по вашей кампании');
  });

  it('eaccount экранируется (HTML в адресе не ломает разметку)', () => {
    const html = buildClientReplyMessage({
      ...base,
      outOfCampaign: true,
      eaccount: 'x<b>@clientmail.ru',
    });
    expect(html).toContain('📬 <b>Ящик:</b> x&lt;b&gt;@clientmail.ru');
  });
});
