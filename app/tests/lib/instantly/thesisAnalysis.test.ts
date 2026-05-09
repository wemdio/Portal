/** @jest-environment node */
import {
  // subject
  subjectHasNumber,
  subjectHasQuestion,
  countWords,
  mentionsName,
  mentionsCompany,
  // body
  countSentences,
  bodyHasTimelineHook,
  hasCtaQuestion,
  hasNumber,
  // heuristic personalization (no lead context needed)
  greetingWithCapitalizedName,
  bodyHasFirstNameGreeting,
  hasTemplateVariable,
  countTemplateVariables,
  // threading
  groupEmailsByThread,
  inferStepNumber,
  didEmailGetReply,
  // stats
  proportionsZTest,
  wilsonInterval,
  bucketize,
  analyzeBinaryFeature,
  analyzeBucketed,
} from '@/lib/instantly/thesisAnalysis';
import type { Email } from '@/lib/instantly/types';

describe('subject extractors', () => {
  it('detects digits in subject', () => {
    expect(subjectHasNumber('Saved 3 hours/week')).toBe(true);
    expect(subjectHasNumber('Quick chat')).toBe(false);
    expect(subjectHasNumber('')).toBe(false);
    expect(subjectHasNumber('Q4 plan')).toBe(true);
  });

  it('detects question mark', () => {
    expect(subjectHasQuestion('Quick question?')).toBe(true);
    expect(subjectHasQuestion('Quick question')).toBe(false);
    expect(subjectHasQuestion('  ?')).toBe(true);
  });

  it('counts words in subject', () => {
    expect(countWords('Quick question?')).toBe(2);
    expect(countWords('  hello   world  foo ')).toBe(3);
    expect(countWords('')).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });

  it('mentionsName matches whole word, case-insensitive, ignores Johnny vs John', () => {
    expect(mentionsName('Hi John, quick question', 'John')).toBe(true);
    expect(mentionsName('hi john', 'John')).toBe(true);
    expect(mentionsName('Hi Johnny', 'John')).toBe(false);
    expect(mentionsName('Hi Иван', 'Иван')).toBe(true);
    expect(mentionsName('subject', '')).toBe(false);
    expect(mentionsName('subject', null)).toBe(false);
  });

  it('mentionsCompany handles LLC/Inc/ООО suffixes and case', () => {
    expect(mentionsCompany('We saw Acme Inc on the news', 'Acme Inc.')).toBe(true);
    expect(mentionsCompany('We saw acme on the news', 'Acme, LLC')).toBe(true);
    expect(mentionsCompany('Greetings to ООО Ромашка', 'Ромашка')).toBe(true);
    expect(mentionsCompany('No mention', 'Acme')).toBe(false);
    expect(mentionsCompany('text', '')).toBe(false);
  });
});

describe('body extractors', () => {
  it('counts sentences with . ! ? but ignores common acronyms', () => {
    expect(countSentences('Hello world. This is a test! Right?')).toBe(3);
    expect(countSentences('e.g. one sentence here.')).toBe(1);
    expect(countSentences('No terminator here')).toBe(1);
    expect(countSentences('')).toBe(0);
  });

  it('detects timeline hooks in EN and RU', () => {
    expect(bodyHasTimelineHook('We can deliver results in 30 days')).toBe(true);
    expect(bodyHasTimelineHook('within 2 weeks')).toBe(true);
    expect(bodyHasTimelineHook('за 14 дней покажем результат')).toBe(true);
    expect(bodyHasTimelineHook('через 3 недели')).toBe(true);
    expect(bodyHasTimelineHook('No specific timeline mentioned')).toBe(false);
  });

  it('hasCtaQuestion detects question + meeting CTA', () => {
    expect(hasCtaQuestion('Open to a quick chat next week?')).toBe(true);
    expect(hasCtaQuestion('Worth a 15-minute call?')).toBe(true);
    expect(hasCtaQuestion('Let me know your thoughts.')).toBe(false);
  });

  it('hasNumber detects digits anywhere', () => {
    expect(hasNumber('We saved 30% on costs')).toBe(true);
    expect(hasNumber('No digits at all')).toBe(false);
  });
});

describe('heuristic personalization (no lead data)', () => {
  it('greetingWithCapitalizedName detects EN greetings + Capitalized name', () => {
    expect(greetingWithCapitalizedName('Hi John,')).toBe(true);
    expect(greetingWithCapitalizedName('Hey Sarah!')).toBe(true);
    expect(greetingWithCapitalizedName('Hello Mike — quick one')).toBe(true);
    expect(greetingWithCapitalizedName('Dear Mr. Johnson,')).toBe(true);
    expect(greetingWithCapitalizedName('hi there')).toBe(false);
    expect(greetingWithCapitalizedName('Hi team,')).toBe(false);
    expect(greetingWithCapitalizedName('Quick question about pricing')).toBe(false);
  });

  it('greetingWithCapitalizedName detects RU greetings', () => {
    expect(greetingWithCapitalizedName('Привет, Иван!')).toBe(true);
    expect(greetingWithCapitalizedName('Здравствуйте, Анна.')).toBe(true);
    expect(greetingWithCapitalizedName('Добрый день, Владимир')).toBe(true);
    expect(greetingWithCapitalizedName('Здравствуйте')).toBe(false);
    expect(greetingWithCapitalizedName('Привет')).toBe(false);
  });

  it('bodyHasFirstNameGreeting checks the first 200 chars only', () => {
    const longTextWithGreetingFar =
      'Some unrelated intro line. '.repeat(20) + 'Hi John, by the way…';
    expect(bodyHasFirstNameGreeting(longTextWithGreetingFar)).toBe(false);
    expect(bodyHasFirstNameGreeting('Hi John, just a quick check…')).toBe(true);
  });

  it('hasTemplateVariable detects {{...}} placeholders', () => {
    expect(hasTemplateVariable('Hi {{firstName}}, quick question?')).toBe(true);
    expect(hasTemplateVariable('Hi { firstName }, quick question?')).toBe(false);
    expect(hasTemplateVariable('No vars here')).toBe(false);
    expect(hasTemplateVariable('{{custom_var_1}}')).toBe(true);
  });

  it('countTemplateVariables counts distinct placeholders', () => {
    expect(countTemplateVariables('Hi {{firstName}}! Welcome to {{companyName}} - {{firstName}}'))
      .toBe(2);
    expect(countTemplateVariables('No vars')).toBe(0);
  });
});

describe('threading and step inference', () => {
  const mkEmail = (over: Partial<Email>): Email => ({
    id: over.id || 'x',
    thread_id: over.thread_id || 't1',
    ue_type: over.ue_type ?? 1,
    timestamp_email: over.timestamp_email,
    lead: 'lead-1',
    ...over,
  });

  it('groups emails by thread_id', () => {
    const emails = [
      mkEmail({ id: 'a', thread_id: 't1' }),
      mkEmail({ id: 'b', thread_id: 't1' }),
      mkEmail({ id: 'c', thread_id: 't2' }),
    ];
    const grouped = groupEmailsByThread(emails);
    expect(grouped.size).toBe(2);
    expect(grouped.get('t1')?.length).toBe(2);
    expect(grouped.get('t2')?.length).toBe(1);
  });

  it('groups emails by lead when thread_id is missing', () => {
    const emails = [
      mkEmail({ id: 'a', thread_id: undefined, lead: 'lead-1' }),
      mkEmail({ id: 'b', thread_id: undefined, lead: 'lead-1' }),
    ];
    const grouped = groupEmailsByThread(emails);
    expect(grouped.get('lead:lead-1')?.length).toBe(2);
  });

  it('inferStepNumber numbers sent emails (ue_type=1) chronologically per thread', () => {
    const t = [
      mkEmail({ id: 's1', ue_type: 1, timestamp_email: '2026-04-01T10:00:00Z' }),
      mkEmail({ id: 'r1', ue_type: 2, timestamp_email: '2026-04-02T10:00:00Z' }),
      mkEmail({ id: 's2', ue_type: 1, timestamp_email: '2026-04-05T10:00:00Z' }),
      mkEmail({ id: 's3', ue_type: 1, timestamp_email: '2026-04-10T10:00:00Z' }),
    ];
    expect(inferStepNumber(t.find((e) => e.id === 's1')!, t)).toBe(1);
    expect(inferStepNumber(t.find((e) => e.id === 's2')!, t)).toBe(2);
    expect(inferStepNumber(t.find((e) => e.id === 's3')!, t)).toBe(3);
    expect(inferStepNumber(t.find((e) => e.id === 'r1')!, t)).toBe(0);
  });

  it('didEmailGetReply true if any ue_type=2 happens after sent email in same thread', () => {
    const sent = mkEmail({ id: 's1', ue_type: 1, timestamp_email: '2026-04-01T10:00:00Z' });
    const reply = mkEmail({ id: 'r1', ue_type: 2, timestamp_email: '2026-04-02T10:00:00Z' });
    expect(didEmailGetReply(sent, [sent, reply])).toBe(true);

    const earlierReply = mkEmail({ id: 'r0', ue_type: 2, timestamp_email: '2026-03-01T10:00:00Z' });
    expect(didEmailGetReply(sent, [sent, earlierReply])).toBe(false);

    expect(didEmailGetReply(sent, [sent])).toBe(false);
  });
});

describe('statistics', () => {
  it('proportionsZTest: known case 50/100 vs 30/100', () => {
    const r = proportionsZTest(50, 100, 30, 100);
    expect(r.z).toBeGreaterThan(2.5);
    expect(r.z).toBeLessThan(3.2);
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.lift).toBeCloseTo((50 / 100 - 30 / 100) / (30 / 100), 5);
  });

  it('proportionsZTest returns null pValue if zero sample', () => {
    const r = proportionsZTest(0, 0, 5, 10);
    expect(r.pValue).toBeNull();
  });

  it('wilsonInterval gives sensible bounds', () => {
    const [lo, hi] = wilsonInterval(50, 100);
    expect(lo).toBeGreaterThan(0.39);
    expect(hi).toBeLessThan(0.61);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });

  it('wilsonInterval handles 0/0', () => {
    const [lo, hi] = wilsonInterval(0, 0);
    expect(lo).toBe(0);
    expect(hi).toBe(0);
  });

  it('bucketize assigns values to half-open buckets [a, b)', () => {
    const edges = [0, 100, 200, 300];
    expect(bucketize(50, edges)).toBe(0);
    expect(bucketize(100, edges)).toBe(1);
    expect(bucketize(199, edges)).toBe(1);
    expect(bucketize(300, edges)).toBe(2);
    expect(bucketize(500, edges)).toBe(2);
    expect(bucketize(-10, edges)).toBe(-1);
  });
});

describe('aggregators', () => {
  type Item = { hasFeat: boolean; replied: boolean };
  it('analyzeBinaryFeature splits items by feature flag and computes lift + p', () => {
    const items: Item[] = [
      ...Array(50).fill({ hasFeat: true, replied: true }),
      ...Array(50).fill({ hasFeat: true, replied: false }),
      ...Array(30).fill({ hasFeat: false, replied: true }),
      ...Array(70).fill({ hasFeat: false, replied: false }),
    ];
    const r = analyzeBinaryFeature(items, (i) => i.hasFeat, (i) => i.replied);
    expect(r.withFeature.n).toBe(100);
    expect(r.withFeature.successes).toBe(50);
    expect(r.withFeature.rate).toBeCloseTo(0.5, 5);
    expect(r.withoutFeature.n).toBe(100);
    expect(r.withoutFeature.successes).toBe(30);
    expect(r.withoutFeature.rate).toBeCloseTo(0.3, 5);
    expect(r.lift).toBeCloseTo((0.5 - 0.3) / 0.3, 5);
    expect(r.zTest.pValue).toBeLessThan(0.01);
  });

  it('analyzeBucketed groups by buckets and computes per-bucket rate', () => {
    const items = [
      { x: 50, ok: true }, { x: 50, ok: false },
      { x: 150, ok: true }, { x: 150, ok: true }, { x: 150, ok: false },
      { x: 250, ok: false }, { x: 250, ok: false },
    ];
    const buckets = analyzeBucketed(items, (i) => i.x, (i) => i.ok, [0, 100, 200, 300]);
    expect(buckets).toHaveLength(3);
    expect(buckets[0].n).toBe(2); expect(buckets[0].rate).toBeCloseTo(0.5, 5);
    expect(buckets[1].n).toBe(3); expect(buckets[1].rate).toBeCloseTo(2 / 3, 5);
    expect(buckets[2].n).toBe(2); expect(buckets[2].rate).toBeCloseTo(0, 5);
  });
});
