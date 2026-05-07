import 'server-only';

import type { EmailSequenceV2RunRow } from '@/types';
import { loadReferenceBundle } from './referenceAssets';

const MAX_BRIEF_CHARS = 12_000;
const MAX_VALUES_CHARS = 8_000;
const MAX_REGULATION_CHARS = 8_000;
const MAX_STRUCTURE_CHARS = 5_000;
const MAX_EXAMPLE_CHARS = 4_000;
const MAX_EXAMPLES = 6;

function trimTo(text: string | null | undefined, max: number): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n\n[…обрезано до ${max} симв.…]`;
}

export async function buildLetterGenerationContext(run: EmailSequenceV2RunRow): Promise<string> {
  const reference = await loadReferenceBundle();

  const parts: string[] = [];

  parts.push('=== БЛОК 1. БРИФ КЛИЕНТА И ЦЕННОСТИ ===');
  parts.push('');
  parts.push('— Бриф клиента (исходный текст PDF/DOCX):');
  parts.push(trimTo(run.brief_text, MAX_BRIEF_CHARS) || '(бриф не приложен)');
  parts.push('');
  parts.push('— Ценности продукта (выделены AI на этапе 1):');
  parts.push(trimTo(run.values_text, MAX_VALUES_CHARS) || '(ценности не сгенерированы)');
  parts.push('');

  parts.push('=== БЛОК 2. СЕГМЕНТ И ПРАВКИ ЗАКАЗЧИКА ===');
  parts.push('');
  parts.push('— Сегмент базы по гипотезе:');
  parts.push((run.segment_text ?? '').trim() || '(не указан)');
  parts.push('');
  parts.push('— Правки от заказчика:');
  parts.push((run.customer_edits ?? '').trim() || '(нет правок)');
  parts.push('');

  parts.push('=== БЛОК 3. РЕГЛАМЕНТ И СТРУКТУРА ПИСЕМ ===');
  parts.push('');
  parts.push('— Регламент написания цепочек:');
  parts.push(trimTo(reference.regulation, MAX_REGULATION_CHARS));
  parts.push('');
  parts.push('— Структура писем в outreach (шаблон):');
  parts.push(trimTo(reference.structure, MAX_STRUCTURE_CHARS));
  parts.push('');

  parts.push('=== БЛОК 4. ПРИМЕРЫ РАБОТАЮЩИХ ЦЕПОЧЕК ===');
  parts.push('');
  parts.push('Изучи примеры цепочек ниже как образец стиля и глубины писем.');
  parts.push('Не копируй дословно — это эталон, не шаблон.');
  parts.push('');
  const examples = reference.examples.slice(0, MAX_EXAMPLES);
  examples.forEach((ex, i) => {
    parts.push(`--- Пример ${i + 1}: ${ex.name} ---`);
    parts.push(trimTo(ex.text, MAX_EXAMPLE_CHARS));
    parts.push('');
  });

  parts.push('=== БЛОК 5. ОПЕРАТОРЫ ДЛЯ ПЕРСОНАЛИЗАЦИИ ===');
  parts.push('');
  const operators = (run.personalization_operators ?? '').trim();
  if (operators) {
    parts.push('Используй эти переменные/конструкции уместно (только реально нужные, не «через одно слово»).');
    parts.push(operators);
  } else {
    parts.push('Операторы не переданы. Пиши без шаблонных подстановок (или используй человекочитаемое имя получателя).');
  }
  parts.push('');

  return parts.join('\n');
}
