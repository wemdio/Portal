import { UNIVERSAL_REPLY_RULES } from './promptRules';
import type { GlobalKnowledgeBase, KnowledgeBase, QualificationRow, ThreadMessage } from './types';

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

function formatThread(thread: ThreadMessage[]): string {
  return thread
    .map((m) => `${m.fromUs ? 'МЫ' : 'ОНИ'} (${m.timestamp ?? '—'}):\n${m.text}`)
    .join('\n\n---\n\n');
}

/** Пер-проектное значение приоритетнее глобального; пустое поле = глобальное. */
function preferProject(projectValue: string, globalValue: string): string {
  return projectValue.trim() ? projectValue : globalValue;
}

export function buildReplyPrompt(input: {
  kb: KnowledgeBase;
  /** Глобальный тон/пример — fallback для проектов без своих значений. */
  globalKb: Pick<GlobalKnowledgeBase, 'toneNotes' | 'exampleCase'>;
  /** Бриф проекта живьём из карточки (projects.brief_text), не из базы знаний. */
  brief: string;
  qualification: QualificationRow;
  thread: ThreadMessage[];
  contextComplete: boolean;
}): PromptMessage[] {
  const { kb, globalKb, brief, qualification, thread, contextComplete } = input;

  const toneNotes = preferProject(kb.toneNotes, globalKb.toneNotes);
  const exampleCase = preferProject(kb.exampleCase, globalKb.exampleCase);
  // Поля фактов в форме больше нет (всё есть в брифе) — блок попадает в
  // промпт, только если у проекта осталось старое заполненное значение.
  const productFacts = kb.productFacts.trim()
    ? `\nДополнительные факты о продукте:\n${kb.productFacts}\n`
    : '';

  const system = `${UNIVERSAL_REPLY_RULES}

О продукте/проекте, для которого пишешь письмо:

Бриф:
${brief || '(бриф проекта не заполнен)'}
${productFacts}
Тон и ограничения этого проекта:
${toneNotes || '(особых ограничений нет, используй деловой тон по умолчанию)'}

Примеры хороших ответов — ориентир по стилю, не копируй дословно. Глобальные
примеры собраны по разным проектам: перенимай манеру (прямой ответ на реплику,
длину, один следующий шаг), но не переноси оттуда факты о продукте, цены и
названия — они относятся к чужим проектам:
${exampleCase || '(примера нет)'}`;

  const user = `Компания-адресат: ${qualification.companyName || qualification.leadEmail}
Email адресата: ${qualification.leadEmail}
${contextComplete ? '' : 'Внимание: полный тред переписки получить не удалось, ниже только сохранённые отрывки — учитывай это и не додумывай детали, которых нет.\n'}
Переписка:

${formatThread(thread)}

Напиши следующий ответ от НАС адресату, отвечая на его последнюю реплику.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
