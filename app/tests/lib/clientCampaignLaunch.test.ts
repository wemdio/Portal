import {
  buildCampaignPayloadFromPreset,
  buildCampaignPresetUpdatePayload,
} from '@/lib/clientLaunch/buildCampaignPayload';
import { validateClientLaunchInput } from '@/lib/clientLaunch/validateLaunchInput';
import { mapCsvRowsToLeads } from '@/lib/clientLaunch/mapRowsToLeads';
import type {
  ClientCampaignPreset,
  ClientLaunchSequence,
  ClientLaunchColumnMapping,
} from '@/lib/clientLaunch/types';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';

const validPreset: ClientCampaignPreset = {
  id: 'preset-1',
  client_user_id: 'user-1',
  instantly_account_id: 'main',
  email_account_ids: ['sender@acme.com', 'sender2@acme.com'],
  daily_limit: 100,
  daily_max_leads: 50,
  email_gap_minutes: 15,
  open_tracking: true,
  link_tracking: true,
  stop_on_reply: true,
  text_only: false,
  schedule_from: '09:00',
  schedule_to: '18:00',
  schedule_days: [1, 2, 3, 4, 5],
  schedule_timezone: 'Europe/Moscow',
  created_by: 'admin-1',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const validSequence: ClientLaunchSequence = {
  name: 'Q2 Outreach',
  steps: [
    { subject: 'Hi {{firstName}}', body: 'Body 1', wait_days: 0 },
    { subject: 'Following up', body: 'Body 2', wait_days: 3 },
  ],
};

describe('buildCampaignPayloadFromPreset', () => {
  it('produces a CampaignCreatePayload with name and email accounts from the preset', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: validPreset,
      sequence: validSequence,
    });
    expect(payload.name).toBe('Q2 Outreach');
    expect(payload.email_list).toEqual(['sender@acme.com', 'sender2@acme.com']);
  });

  it('transfers tracking and stop flags from the preset', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: { ...validPreset, open_tracking: false, link_tracking: false, stop_on_reply: false },
      sequence: validSequence,
    });
    expect(payload.open_tracking).toBe(false);
    expect(payload.link_tracking).toBe(false);
    expect(payload.stop_on_reply).toBe(false);
  });

  it('allows per-launch overrides for open tracking and stop-on-reply', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: { ...validPreset, open_tracking: true, stop_on_reply: true },
      sequence: validSequence,
      behaviorOverride: { open_tracking: false, stop_on_reply: false },
    });
    expect(payload.open_tracking).toBe(false);
    expect(payload.stop_on_reply).toBe(false);
    expect(payload.link_tracking).toBe(true);
  });

  it('always forces text_only=true (client emails are plain text, no HTML)', () => {
    // Client emails must go out exactly as typed — plain text, line breaks
    // preserved, no HTML. text_only is forced regardless of the preset.
    const fromTextPreset = buildCampaignPayloadFromPreset({
      preset: { ...validPreset, text_only: true },
      sequence: validSequence,
    });
    const fromHtmlPreset = buildCampaignPayloadFromPreset({
      preset: { ...validPreset, text_only: false },
      sequence: validSequence,
    });
    expect(fromTextPreset.text_only).toBe(true);
    expect(fromHtmlPreset.text_only).toBe(true);
  });

  it('transfers daily_limit, daily_max_leads, and email_gap from the preset', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: validPreset,
      sequence: validSequence,
    });
    expect(payload.daily_limit).toBe(100);
    expect(payload.daily_max_leads).toBe(50);
    expect(payload.email_gap).toBe(15);
  });

  it('translates schedule_days int[] to days object {1: true, 2: true, ...}', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: { ...validPreset, schedule_days: [1, 3, 5] },
      sequence: validSequence,
    });
    const entry = payload.campaign_schedule.schedules[0];
    expect(entry.days[1]).toBe(true);
    expect(entry.days[3]).toBe(true);
    expect(entry.days[5]).toBe(true);
    expect(entry.days[2]).toBeFalsy();
    expect(entry.days[4]).toBeFalsy();
    expect(entry.days[6]).toBeFalsy();
    expect(entry.days[0]).toBeFalsy();
  });

  it('uses preset timezone, schedule_from, and schedule_to', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: { ...validPreset, schedule_timezone: 'Asia/Yekaterinburg', schedule_from: '08:30', schedule_to: '17:30' },
      sequence: validSequence,
    });
    const entry = payload.campaign_schedule.schedules[0];
    expect(entry.timezone).toBe('Asia/Yekaterinburg');
    expect(entry.timing.from).toBe('08:30');
    expect(entry.timing.to).toBe('17:30');
  });

  it('maps each step to the Instantly v2 shape: type / delay_unit / variants[]', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: validPreset,
      sequence: validSequence,
    });
    expect(payload.sequences).toBeDefined();
    expect(payload.sequences?.[0].steps).toHaveLength(2);
    const step0 = payload.sequences![0].steps[0];
    expect(step0.type).toBe('email');
    expect(step0.delay_unit).toBe('days');
    // Content lives in variants[], not on the step itself (Instantly v2).
    expect(step0.variants?.[0].subject).toBe('Hi {{firstName}}');
    expect(step0.variants?.[0].body).toBe('Body 1');
    expect(payload.sequences?.[0].steps[1].variants?.[0].body).toBe('Body 2');
  });

  it('sets per-step delay to the NEXT step wait_days; last step is filler', () => {
    // validSequence: step0 wait_days=0, step1 wait_days=3. Instantly `delay`
    // is "days before the next email", so step0.delay = 3 (gap before
    // step1); the last step has no next email → filler 1.
    const payload = buildCampaignPayloadFromPreset({
      preset: validPreset,
      sequence: validSequence,
    });
    const steps = payload.sequences![0].steps;
    expect(steps[0].delay).toBe(3);
    expect(steps[1].delay).toBe(1);
  });

  it('preserves empty subject for follow-up steps (continues thread)', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          { subject: 'Hi', body: 'b1', wait_days: 0 },
          { subject: '', body: 'b2', wait_days: 3 },
        ],
      },
    });
    expect(payload.sequences?.[0].steps[1].variants?.[0].subject).toBe('');
  });

  it('emits variants in A/B/C order: the step subject/body first, then extras', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          {
            subject: 'A subj',
            body: 'A body',
            wait_days: 0,
            variants: [
              { subject: 'B subj', body: 'B body' },
              { subject: 'C subj', body: 'C body' },
            ],
          },
        ],
      },
    });
    const step = payload.sequences?.[0].steps[0];
    expect(step?.variants).toHaveLength(3);
    expect(step?.variants?.[0]).toEqual({ subject: 'A subj', body: 'A body' });
    expect(step?.variants?.[1]).toEqual({ subject: 'B subj', body: 'B body' });
    expect(step?.variants?.[2]).toEqual({ subject: 'C subj', body: 'C body' });
  });

  it('always emits variants[]: a step with no extra variants still has Variant A', () => {
    const payload = buildCampaignPayloadFromPreset({
      preset: validPreset,
      sequence: validSequence,
    });
    const step = payload.sequences?.[0].steps[0];
    expect(step?.variants).toHaveLength(1);
    expect(step?.variants?.[0].body).toBe('Body 1');
  });
});

describe('validateClientLaunchInput', () => {
  const validMapping: ClientLaunchColumnMapping = {
    email: 'Email',
    first_name: 'First Name',
  };

  it('rejects when preset is not configured', () => {
    const result = validateClientLaunchInput({
      preset: null,
      sequence: validSequence,
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/пресет/i);
  });

  it('rejects when preset has no email accounts', () => {
    const result = validateClientLaunchInput({
      preset: { ...validPreset, email_account_ids: [] },
      sequence: validSequence,
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/аккаунт/i);
  });

  it('rejects sequence with no steps', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: { name: 'X', steps: [] },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/шаг/i);
  });

  it('rejects step 1 missing subject', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: { name: 'X', steps: [{ subject: '', body: 'b', wait_days: 0 }] },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/тем/i);
  });

  it('accepts step 2+ with empty subject (continues thread)', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          { subject: 'Hi', body: 'b1', wait_days: 0 },
          { subject: '', body: 'b2', wait_days: 3 },
          { subject: '   ', body: 'b3', wait_days: 5 },
        ],
      },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts step with extra A/B variants', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          {
            subject: 'A subj',
            body: 'A body',
            wait_days: 0,
            variants: [
              { subject: 'B subj', body: 'B body' },
              { subject: 'C subj', body: 'C body' },
            ],
          },
        ],
      },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects variant with empty body', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          {
            subject: 's',
            body: 'b',
            wait_days: 0,
            variants: [{ subject: 'B', body: '' }],
          },
        ],
      },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/вариант/i);
  });

  it('rejects step 1 variant with empty subject', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          {
            subject: 's',
            body: 'b',
            wait_days: 0,
            variants: [{ subject: '', body: 'B body' }],
          },
        ],
      },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/тем/i);
  });

  it('accepts step 2 variant with empty subject', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          { subject: 'Hi', body: 'b1', wait_days: 0 },
          {
            subject: '',
            body: 'b2',
            wait_days: 3,
            variants: [{ subject: '', body: 'b2 alt' }],
          },
        ],
      },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when variants exceed maximum (max 3 total per step → 2 extra)', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          {
            subject: 'A',
            body: 'a',
            wait_days: 0,
            variants: [
              { subject: 'B', body: 'b' },
              { subject: 'C', body: 'c' },
              { subject: 'D', body: 'd' },
            ],
          },
        ],
      },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/вариант/i);
  });

  it('accepts exactly 2 extra variants (3 total: A + B + C)', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: {
        name: 'X',
        steps: [
          {
            subject: 'A',
            body: 'a',
            wait_days: 0,
            variants: [
              { subject: 'B', body: 'b' },
              { subject: 'C', body: 'c' },
            ],
          },
        ],
      },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects sequence step missing body', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: { name: 'X', steps: [{ subject: 's', body: '', wait_days: 0 }] },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/текст/i);
  });

  it('rejects empty campaign name', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: { name: '   ', steps: validSequence.steps },
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/назв/i);
  });

  it('rejects when row count exceeds 10 000', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: validSequence,
      mapping: validMapping,
      rowCount: CLIENT_LAUNCH_ROW_LIMIT + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/10\s?000/);
  });

  it('rejects 0 rows', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: validSequence,
      mapping: validMapping,
      rowCount: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/пуст/i);
  });

  it('rejects when mapping has no email column', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: validSequence,
      mapping: { email: '' } as unknown as ClientLaunchColumnMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/email/i);
  });

  it('passes valid input', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: validSequence,
      mapping: validMapping,
      rowCount: 100,
    });
    expect(result.ok).toBe(true);
  });

  it('passes at exactly 10 000 rows', () => {
    const result = validateClientLaunchInput({
      preset: validPreset,
      sequence: validSequence,
      mapping: validMapping,
      rowCount: CLIENT_LAUNCH_ROW_LIMIT,
    });
    expect(result.ok).toBe(true);
  });
});

describe('mapCsvRowsToLeads', () => {
  const headers = ['Email', 'First Name', 'Last Name', 'Company', 'Site', 'Industry', 'Size'];

  it('extracts email by mapped column', () => {
    const leads = mapCsvRowsToLeads({
      headers,
      rows: [['JOHN@ACME.com', 'John', 'Doe', 'Acme', 'acme.com', 'IT', '50']],
      mapping: { email: 'Email' },
    });
    expect(leads).toHaveLength(1);
    expect(leads[0].email).toBe('john@acme.com');
  });

  it('extracts standard fields when mapped (first_name, last_name, company_name, website, phone)', () => {
    const leads = mapCsvRowsToLeads({
      headers: ['e', 'fn', 'ln', 'cn', 'web', 'ph'],
      rows: [['a@b.com', 'John', 'Doe', 'Acme', 'acme.com', '+79991234567']],
      mapping: {
        email: 'e',
        first_name: 'fn',
        last_name: 'ln',
        company_name: 'cn',
        website: 'web',
        phone: 'ph',
      },
    });
    expect(leads[0].first_name).toBe('John');
    expect(leads[0].last_name).toBe('Doe');
    expect(leads[0].company_name).toBe('Acme');
    expect(leads[0].website).toBe('acme.com');
    expect(leads[0].phone).toBe('+79991234567');
  });

  it('puts unmapped columns into custom_variables', () => {
    const leads = mapCsvRowsToLeads({
      headers,
      rows: [['a@b.com', 'John', 'Doe', 'Acme', 'acme.com', 'IT', '50']],
      mapping: { email: 'Email', first_name: 'First Name' },
    });
    expect(leads[0].custom_variables).toBeDefined();
    expect(leads[0].custom_variables?.['Last Name']).toBe('Doe');
    expect(leads[0].custom_variables?.['Company']).toBe('Acme');
    expect(leads[0].custom_variables?.['Industry']).toBe('IT');
    expect(leads[0].custom_variables?.['Size']).toBe('50');
  });

  it('respects explicit custom variable mapping under custom_variables_mapping', () => {
    const leads = mapCsvRowsToLeads({
      headers: ['Email', 'CompanySize'],
      rows: [['a@b.com', '500']],
      mapping: {
        email: 'Email',
        custom_variables_mapping: { company_size: 'CompanySize' },
      },
    });
    expect(leads[0].custom_variables?.company_size).toBe('500');
  });

  it('skips rows with empty email', () => {
    const leads = mapCsvRowsToLeads({
      headers: ['Email', 'Name'],
      rows: [['a@b.com', 'John'], ['', 'Mary'], ['  ', 'Bob']],
      mapping: { email: 'Email' },
    });
    expect(leads).toHaveLength(1);
    expect(leads[0].email).toBe('a@b.com');
  });

  it('skips rows with malformed email (no @ sign)', () => {
    const leads = mapCsvRowsToLeads({
      headers: ['Email'],
      rows: [['a@b.com'], ['not-an-email'], ['c@d.org']],
      mapping: { email: 'Email' },
    });
    expect(leads).toHaveLength(2);
    expect(leads.map((l) => l.email)).toEqual(['a@b.com', 'c@d.org']);
  });

  it('lowercases and trims emails', () => {
    const leads = mapCsvRowsToLeads({
      headers: ['Email'],
      rows: [['  ALICE@ACME.COM  ']],
      mapping: { email: 'Email' },
    });
    expect(leads[0].email).toBe('alice@acme.com');
  });

  it('returns empty when email column is missing from headers', () => {
    const leads = mapCsvRowsToLeads({
      headers: ['Name'],
      rows: [['John']],
      mapping: { email: 'NonExistent' },
    });
    expect(leads).toEqual([]);
  });

  it('does not include custom_variables key if there are no extra columns', () => {
    const leads = mapCsvRowsToLeads({
      headers: ['Email', 'fn'],
      rows: [['a@b.com', 'John']],
      mapping: { email: 'Email', first_name: 'fn' },
    });
    expect(leads[0].custom_variables).toBeUndefined();
  });
});

describe('buildCampaignPresetUpdatePayload', () => {
  it('returns an empty payload when no preset keys changed', () => {
    const payload = buildCampaignPresetUpdatePayload({
      preset: validPreset,
      changedPresetKeys: new Set(),
    });
    expect(payload).toEqual({});
  });

  it('includes only the fields the admin actually changed', () => {
    const payload = buildCampaignPresetUpdatePayload({
      preset: { ...validPreset, daily_limit: 1000 },
      changedPresetKeys: new Set(['daily_limit']),
    });
    expect(payload).toEqual({ daily_limit: 1000 });
    expect(payload.email_list).toBeUndefined();
    expect(payload.daily_max_leads).toBeUndefined();
    expect(payload.campaign_schedule).toBeUndefined();
  });

  it('maps preset.email_account_ids → email_list as a fresh array', () => {
    const accounts = ['a@x.com', 'b@x.com', 'c@x.com'];
    const payload = buildCampaignPresetUpdatePayload({
      preset: { ...validPreset, email_account_ids: accounts },
      changedPresetKeys: new Set(['email_account_ids']),
    });
    expect(payload.email_list).toEqual(accounts);
    // Defensive copy — mutating the input should not leak into the payload.
    expect(payload.email_list).not.toBe(accounts);
  });

  it('maps preset.email_gap_minutes → email_gap (preset key differs from API key)', () => {
    const payload = buildCampaignPresetUpdatePayload({
      preset: { ...validPreset, email_gap_minutes: 42 },
      changedPresetKeys: new Set(['email_gap_minutes']),
    });
    expect(payload.email_gap).toBe(42);
  });

  it('propagates daily_max_leads when changed', () => {
    const payload = buildCampaignPresetUpdatePayload({
      preset: { ...validPreset, daily_max_leads: 200 },
      changedPresetKeys: new Set(['daily_max_leads']),
    });
    expect(payload.daily_max_leads).toBe(200);
  });

  it('propagates boolean flags (open_tracking, link_tracking, stop_on_reply)', () => {
    const payload = buildCampaignPresetUpdatePayload({
      preset: {
        ...validPreset,
        open_tracking: false,
        link_tracking: false,
        stop_on_reply: false,
      },
      changedPresetKeys: new Set(['open_tracking', 'link_tracking', 'stop_on_reply']),
    });
    expect(payload.open_tracking).toBe(false);
    expect(payload.link_tracking).toBe(false);
    expect(payload.stop_on_reply).toBe(false);
  });

  it('rebuilds the full campaign_schedule when ANY schedule field changes', () => {
    // Even if only schedule_from is in changedPresetKeys, the resulting payload
    // must contain the complete schedule structure — partial schedule updates
    // would leave Instantly with inconsistent timing.
    const payload = buildCampaignPresetUpdatePayload({
      preset: {
        ...validPreset,
        schedule_from: '10:00',
        schedule_to: '20:00',
        schedule_days: [1, 3, 5],
        schedule_timezone: 'Europe/Moscow',
      },
      changedPresetKeys: new Set(['schedule_from']),
    });
    expect(payload.campaign_schedule).toBeDefined();
    const schedule = payload.campaign_schedule!.schedules[0];
    expect(schedule.timing.from).toBe('10:00');
    expect(schedule.timing.to).toBe('20:00');
    expect(schedule.days).toEqual({ 1: true, 3: true, 5: true });
    expect(schedule.timezone).toBeTruthy();
  });

  it('does not rebuild schedule when no schedule field changed', () => {
    const payload = buildCampaignPresetUpdatePayload({
      preset: validPreset,
      changedPresetKeys: new Set(['daily_limit']),
    });
    expect(payload.campaign_schedule).toBeUndefined();
  });

  it('never includes name, sequences, text_only, or instantly_account_id', () => {
    // These fields are explicitly excluded — name/sequences are per-campaign,
    // text_only is forced at create, and instantly_account_id is the workspace
    // selector (a campaign can't migrate workspaces).
    const payload = buildCampaignPresetUpdatePayload({
      preset: { ...validPreset, text_only: true },
      // Pretend EVERY preset key changed:
      changedPresetKeys: new Set([
        'email_account_ids',
        'daily_limit',
        'daily_max_leads',
        'email_gap_minutes',
        'open_tracking',
        'link_tracking',
        'stop_on_reply',
        'text_only',
        'instantly_account_id',
        'schedule_from',
        'schedule_to',
        'schedule_days',
        'schedule_timezone',
      ]),
    });
    const typed = payload as Record<string, unknown>;
    expect(typed.name).toBeUndefined();
    expect(typed.sequences).toBeUndefined();
    expect(typed.text_only).toBeUndefined();
    expect(typed.instantly_account_id).toBeUndefined();
  });

  it('combines multiple changed fields into a single payload', () => {
    const payload = buildCampaignPresetUpdatePayload({
      preset: {
        ...validPreset,
        daily_limit: 500,
        daily_max_leads: 75,
        email_account_ids: ['only@x.com'],
        open_tracking: false,
      },
      changedPresetKeys: new Set([
        'daily_limit',
        'daily_max_leads',
        'email_account_ids',
        'open_tracking',
      ]),
    });
    expect(payload).toEqual({
      daily_limit: 500,
      daily_max_leads: 75,
      email_list: ['only@x.com'],
      open_tracking: false,
    });
  });

  it('ignores unknown keys in changedPresetKeys without throwing', () => {
    // Defensive: if some future preset field is added to the PUT body but
    // not to the sync mapping, the helper should silently ignore it
    // instead of failing or producing junk.
    const payload = buildCampaignPresetUpdatePayload({
      preset: validPreset,
      changedPresetKeys: new Set(['totally_unknown_field', 'another_one']),
    });
    expect(payload).toEqual({});
  });

  it('filters out-of-range schedule_days entries when rebuilding the schedule', () => {
    // Mirrors the same defensive filter buildCampaignPayloadFromPreset uses
    // for create payloads (values outside 0..6 are silently dropped).
    const payload = buildCampaignPresetUpdatePayload({
      preset: { ...validPreset, schedule_days: [-1, 0, 2, 6, 7, 99] },
      changedPresetKeys: new Set(['schedule_days']),
    });
    expect(payload.campaign_schedule!.schedules[0].days).toEqual({ 0: true, 2: true, 6: true });
  });
});
