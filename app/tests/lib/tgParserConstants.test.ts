import {
  clampTgParserMaxContactsPerRun,
  TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT,
  TG_PARSER_MAX_CONTACTS_PER_RUN_MAX,
} from '@/lib/tgParser/constants';

describe('tgParser max contacts per run', () => {
  it('uses default 500 and max 100000', () => {
    expect(TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT).toBe(500);
    expect(TG_PARSER_MAX_CONTACTS_PER_RUN_MAX).toBe(100_000);
  });

  it('clamps to 1..max', () => {
    expect(clampTgParserMaxContactsPerRun(0)).toBe(1);
    expect(clampTgParserMaxContactsPerRun(-1)).toBe(1);
    expect(clampTgParserMaxContactsPerRun(200_000)).toBe(TG_PARSER_MAX_CONTACTS_PER_RUN_MAX);
    expect(clampTgParserMaxContactsPerRun(1000)).toBe(1000);
    expect(clampTgParserMaxContactsPerRun(500.7)).toBe(500);
  });

  it('returns default for non-finite input', () => {
    expect(clampTgParserMaxContactsPerRun(NaN)).toBe(TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT);
    expect(clampTgParserMaxContactsPerRun(undefined)).toBe(TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT);
  });
});
