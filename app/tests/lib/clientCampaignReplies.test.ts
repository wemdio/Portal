import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import type { Email } from '@/lib/instantly/types';

function baseEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'em-1',
    timestamp_email: '2026-04-29T10:00:00Z',
    subject: 'Re: ваше предложение',
    from_address_email: 'lead@acme.com',
    from_address_json: [{ address: 'lead@acme.com', name: 'Иван Петров' }],
    to_address_email_list: 'us@polza.ru',
    eaccount: 'us@polza.ru',
    lead: 'lead-uuid-1',
    campaign_id: 'cmp-1',
    thread_id: 'thr-1',
    ue_type: 2,
    is_unread: 1,
    ai_interest_value: 3,
    content_preview: 'Спасибо, давайте созвонимся',
    body: { text: 'Спасибо за письмо.\nДавайте созвонимся в среду.', html: '<p>Спасибо</p>' },
    ...overrides,
  };
}

describe('mapInstantlyEmailToReply', () => {
  it('маппит ключевые публичные поля', () => {
    const out = mapInstantlyEmailToReply(baseEmail());
    expect(out).toEqual(
      expect.objectContaining({
        id: 'em-1',
        timestamp: '2026-04-29T10:00:00Z',
        subject: 'Re: ваше предложение',
        from_email: 'lead@acme.com',
        from_name: 'Иван Петров',
        lead_id: 'lead-uuid-1',
        thread_id: 'thr-1',
        is_unread: true,
        ai_interest_value: 3,
        content_preview: 'Спасибо, давайте созвонимся',
      }),
    );
  });

  it('извлекает body как plain text (предпочитает body.text)', () => {
    const out = mapInstantlyEmailToReply(baseEmail());
    expect(out.body_text).toBe('Спасибо за письмо.\nДавайте созвонимся в среду.');
  });

  it('если body — строка HTML, конвертирует в plain text', () => {
    const out = mapInstantlyEmailToReply(
      baseEmail({ body: '<p>Привет!<br>Как дела?</p>' as unknown as Email['body'] }),
    );
    expect(out.body_text).toBe('Привет!\nКак дела?');
  });

  it('если только body.html — извлекает текст из HTML', () => {
    const out = mapInstantlyEmailToReply(
      baseEmail({ body: { html: '<p>Только <b>HTML</b></p>' } }),
    );
    expect(out.body_text).toBe('Только HTML');
  });

  it('НЕ протекают внутренние/служебные поля', () => {
    const out = mapInstantlyEmailToReply(baseEmail()) as unknown as Record<string, unknown>;
    expect(out.eaccount).toBeUndefined();
    expect(out.i_status).toBeUndefined();
    expect(out.is_focused).toBeUndefined();
    expect(out.from_address_json).toBeUndefined();
    expect(out.to_address_json).toBeUndefined();
    expect(out.body).toBeUndefined();
  });

  it('is_unread корректно бинаризуется (0/undefined → false, 1+ → true)', () => {
    expect(mapInstantlyEmailToReply(baseEmail({ is_unread: 0 })).is_unread).toBe(false);
    expect(mapInstantlyEmailToReply(baseEmail({ is_unread: undefined })).is_unread).toBe(false);
    expect(mapInstantlyEmailToReply(baseEmail({ is_unread: 1 })).is_unread).toBe(true);
    expect(mapInstantlyEmailToReply(baseEmail({ is_unread: 5 })).is_unread).toBe(true);
  });

  it('падает на отсутствующий timestamp — берёт timestamp_created как fallback', () => {
    const out = mapInstantlyEmailToReply(
      baseEmail({ timestamp_email: undefined, timestamp_created: '2026-04-28T09:00:00Z' }),
    );
    expect(out.timestamp).toBe('2026-04-28T09:00:00Z');
  });

  it('если from_address_json пуст — берёт name из from_address_email', () => {
    const out = mapInstantlyEmailToReply(
      baseEmail({ from_address_json: undefined, from_address_email: 'noname@x.com' }),
    );
    expect(out.from_email).toBe('noname@x.com');
    expect(out.from_name).toBeNull();
  });

  it('обрезает слишком длинный body_text (защита от выгрузки гигабайт)', () => {
    const huge = 'A'.repeat(100_000);
    const out = mapInstantlyEmailToReply(baseEmail({ body: { text: huge } }));
    expect(out.body_text!.length).toBeLessThanOrEqual(20_000);
  });

  it('контент-превью обрезается до 200 символов', () => {
    const long = 'X'.repeat(500);
    const out = mapInstantlyEmailToReply(baseEmail({ content_preview: long }));
    expect(out.content_preview!.length).toBeLessThanOrEqual(200);
  });
});
