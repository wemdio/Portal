/** @jest-environment node */

import type { KnowledgeBase, QualificationRow } from '@/lib/replyPersonalization/types';

const KB_EMPTY: KnowledgeBase = {
  projectId: 'p1',
  productFacts: 'факты',
  toneNotes: '',
  exampleCase: '',
  updatedAt: '2026-09-16T00:00:00Z',
};

const QUALIFICATION: QualificationRow = {
  id: 'q1',
  campaignId: 'c1',
  campaignName: null,
  leadEmail: 'lead@example.com',
  companyName: 'ООО Ромашка',
  threadId: 't1',
  replySubject: null,
  replyBody: null,
  lastOutboundPreview: null,
  instantlyEmailId: null,
  eaccount: null,
  replyTimestamp: null,
};

const BASE_INPUT = {
  kb: KB_EMPTY,
  brief: 'бриф проекта',
  qualification: QUALIFICATION,
  thread: [{ fromUs: false, text: 'Здравствуйте!', timestamp: '2026-09-16T10:00:00Z' }],
  contextComplete: true,
};

describe('buildReplyPrompt — приоритет тона и примера письма', () => {
  it('пустое поле проекта → используется глобальное значение', async () => {
    const { buildReplyPrompt } = await import('@/lib/replyPersonalization/buildPrompt');
    const system = buildReplyPrompt({
      ...BASE_INPUT,
      globalKb: { toneNotes: 'глобальный тон', exampleCase: 'глобальный пример' },
    })[0].content;
    expect(system).toContain('глобальный тон');
    expect(system).toContain('глобальный пример');
  });

  it('своё значение проекта приоритетнее глобального', async () => {
    const { buildReplyPrompt } = await import('@/lib/replyPersonalization/buildPrompt');
    const system = buildReplyPrompt({
      ...BASE_INPUT,
      kb: { ...KB_EMPTY, toneNotes: 'тон проекта', exampleCase: 'пример проекта' },
      globalKb: { toneNotes: 'глобальный тон', exampleCase: 'глобальный пример' },
    })[0].content;
    expect(system).toContain('тон проекта');
    expect(system).toContain('пример проекта');
    expect(system).not.toContain('глобальный тон');
    expect(system).not.toContain('глобальный пример');
  });

  it('нет ни своего, ни глобального — заглушки в промпте', async () => {
    const { buildReplyPrompt } = await import('@/lib/replyPersonalization/buildPrompt');
    const system = buildReplyPrompt({
      ...BASE_INPUT,
      globalKb: { toneNotes: '', exampleCase: '' },
    })[0].content;
    expect(system).toContain('(особых ограничений нет');
    expect(system).toContain('(примера нет)');
  });
});
