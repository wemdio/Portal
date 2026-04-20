/** @jest-environment node */
import { buildEmailsExportRows, INSTANTLY_INTEREST_LABELS, UE_TYPE_LABELS } from '@/lib/instantly/emailsExport';
import type { Email, Lead } from '@/lib/instantly/types';

const baseLead: Lead = {
  id: 'lead-1',
  email: 'john@acme.com',
  first_name: 'John',
  last_name: 'Doe',
  company_name: 'Acme',
  title: 'CEO',
  phone: '+1',
  website: 'acme.com',
  linkedin_url: 'linkedin.com/in/jd',
  interest_status: 1,
};

const baseEmail: Email = {
  id: 'em-1',
  lead: 'lead-1',
  campaign_id: 'c-1',
  ue_type: 2,
  subject: 'Re: Hello',
  body: { text: 'Interested!' },
  eaccount: 'sender@ourco.com',
  timestamp_email: '2026-04-20T10:00:00Z',
  thread_id: 'th-1',
};

describe('buildEmailsExportRows', () => {
  it('joins email with lead data and resolves Instantly status label', () => {
    const rows = buildEmailsExportRows([baseEmail], new Map([['lead-1', baseLead]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      'Дата': '2026-04-20T10:00:00Z',
      'Тип': UE_TYPE_LABELS[2],
      'Email лида': 'john@acme.com',
      'Имя': 'John Doe',
      'Компания': 'Acme',
      'Должность': 'CEO',
      'Телефон': '+1',
      'Сайт': 'acme.com',
      'LinkedIn': 'linkedin.com/in/jd',
      'Аккаунт-отправитель': 'sender@ourco.com',
      'Тема': 'Re: Hello',
      'Текст': 'Interested!',
      'Статус Instantly': INSTANTLY_INTEREST_LABELS[1],
      'Lead ID': 'lead-1',
      'Email ID': 'em-1',
      'Thread ID': 'th-1',
    });
  });

  it('extracts text from html body and strips tags', () => {
    const email: Email = { ...baseEmail, id: 'em-2', body: { html: '<p>Hello<br/>World</p>' } };
    const rows = buildEmailsExportRows([email], new Map([['lead-1', baseLead]]));
    expect(rows[0]['Текст']).toContain('Hello');
    expect(rows[0]['Текст']).toContain('World');
    expect(rows[0]['Текст']).not.toContain('<p>');
  });

  it('handles string body directly', () => {
    const email: Email = { ...baseEmail, id: 'em-str', body: 'Plain string body' };
    const rows = buildEmailsExportRows([email], new Map([['lead-1', baseLead]]));
    expect(rows[0]['Текст']).toBe('Plain string body');
  });

  it('handles missing lead gracefully (orphan email)', () => {
    const email: Email = { ...baseEmail, id: 'em-3', lead: 'unknown-lead' };
    const rows = buildEmailsExportRows([email], new Map());
    expect(rows[0]['Email лида']).toBe('');
    expect(rows[0]['Имя']).toBe('');
    expect(rows[0]['Статус Instantly']).toBe('');
  });

  it('sorts emails chronologically ascending by timestamp_email', () => {
    const e1: Email = { ...baseEmail, id: 'a', timestamp_email: '2026-04-20T12:00:00Z' };
    const e2: Email = { ...baseEmail, id: 'b', timestamp_email: '2026-04-20T10:00:00Z' };
    const e3: Email = { ...baseEmail, id: 'c', timestamp_email: '2026-04-20T11:00:00Z' };
    const rows = buildEmailsExportRows([e1, e2, e3], new Map([['lead-1', baseLead]]));
    expect(rows.map((r) => r['Email ID'])).toEqual(['b', 'c', 'a']);
  });

  it('falls back to timestamp_created when timestamp_email missing', () => {
    const email: Email = { ...baseEmail, id: 'em-4', timestamp_email: undefined, timestamp_created: '2026-04-19T08:00:00Z' };
    const rows = buildEmailsExportRows([email], new Map([['lead-1', baseLead]]));
    expect(rows[0]['Дата']).toBe('2026-04-19T08:00:00Z');
  });

  it('handles all ue_type variants (1=sent, 2=lead reply, 3=our reply)', () => {
    const sent: Email = { ...baseEmail, id: '1', ue_type: 1 };
    const reply: Email = { ...baseEmail, id: '2', ue_type: 2 };
    const ourReply: Email = { ...baseEmail, id: '3', ue_type: 3 };
    const rows = buildEmailsExportRows([sent, reply, ourReply], new Map([['lead-1', baseLead]]));
    expect(rows.map((r) => r['Тип'])).toEqual([
      UE_TYPE_LABELS[1], UE_TYPE_LABELS[2], UE_TYPE_LABELS[3],
    ]);
  });

  it('handles all interest_status values', () => {
    for (const [status, label] of Object.entries(INSTANTLY_INTEREST_LABELS)) {
      const lead = { ...baseLead, interest_status: Number(status) };
      const rows = buildEmailsExportRows([baseEmail], new Map([['lead-1', lead]]));
      expect(rows[0]['Статус Instantly']).toBe(label);
    }
  });

  it('returns empty array for empty input', () => {
    const rows = buildEmailsExportRows([], new Map());
    expect(rows).toHaveLength(0);
  });
});
