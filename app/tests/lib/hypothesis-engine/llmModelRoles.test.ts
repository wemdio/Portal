/** @jest-environment node */

/**
 * Роль 'gate' в llm.ts: дешёвые классификационные LLM-задачи (relevance-gate,
 * сегментная классификация лидов, case-bank) идут на мини-модели
 * (openai/gpt-4o-mini по умолчанию, env HE_MODEL_GATE), а не на основной
 * bulk/research — gpt-5.5 с reasoning жёг 1.5–6k выходных токенов и ~$0.06
 * на батч 50 строк (и утыкался в maxTokens=2048 → finish_reason='length'),
 * mini-модель делает ту же классификацию на порядок дешевле и без усечений.
 * Роли research/chain/bulk при этом не меняются.
 */

import { getHeModel } from '@/lib/hypothesisEngine/llm';

describe('getHeModel — роль gate', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('defaults to the cheap mini model when HE_MODEL_GATE is unset', () => {
    delete process.env.HE_MODEL_GATE;
    expect(getHeModel('gate')).toBe('openai/gpt-4o-mini');
  });

  it('honors HE_MODEL_GATE when set', () => {
    process.env.HE_MODEL_GATE = 'openai/gpt-5-nano';
    expect(getHeModel('gate')).toBe('openai/gpt-5-nano');
  });

  it('falls back to the default on blank env', () => {
    process.env.HE_MODEL_GATE = '   ';
    expect(getHeModel('gate')).toBe('openai/gpt-4o-mini');
  });

  it('keeps the existing roles intact', () => {
    delete process.env.HE_MODEL_RESEARCH;
    delete process.env.HE_MODEL_CHAIN;
    delete process.env.HE_MODEL_BULK;
    expect(getHeModel('research')).toBe('anthropic/claude-opus-5');
    expect(getHeModel('chain')).toBe('anthropic/claude-opus-5');
    expect(getHeModel('bulk')).toBe('anthropic/claude-sonnet-4-6');
  });
});
