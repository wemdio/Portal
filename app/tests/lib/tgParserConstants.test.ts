import {
  clampTgParserDailyLimit,
  TG_PARSER_DAILY_LIMIT_DEFAULT,
  TG_PARSER_DAILY_LIMIT_MAX,
} from '@/lib/tgParser/constants';

describe('tgParser daily limit constants', () => {
  it('uses default 500 and max 5000', () => {
    expect(TG_PARSER_DAILY_LIMIT_DEFAULT).toBe(500);
    expect(TG_PARSER_DAILY_LIMIT_MAX).toBe(5000);
  });

  it('clamps to 0..max', () => {
    expect(clampTgParserDailyLimit(-1)).toBe(0);
    expect(clampTgParserDailyLimit(6000)).toBe(TG_PARSER_DAILY_LIMIT_MAX);
    expect(clampTgParserDailyLimit(1000)).toBe(1000);
    expect(clampTgParserDailyLimit(500.7)).toBe(500);
  });

  it('returns default for non-finite input', () => {
    expect(clampTgParserDailyLimit(NaN)).toBe(TG_PARSER_DAILY_LIMIT_DEFAULT);
    expect(clampTgParserDailyLimit(undefined)).toBe(TG_PARSER_DAILY_LIMIT_DEFAULT);
  });
});
