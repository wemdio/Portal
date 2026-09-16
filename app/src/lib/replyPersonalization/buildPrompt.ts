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

  const system = `${UNIVERSAL_REPLY_RULES}

О продукте/проекте, для которого пишешь письмо:

Бриф:
${brief || '(бриф проекта не заполнен)'}

Факты о продукте и что можно предлагать:
${kb.productFacts || '(факты не заполнены)'}

Тон и ограничения этого проекта:
${toneNotes || '(особых ограничений нет, используй деловой тон по умолчанию)'}

Пример хорошего письма для этого проекта (ориентир по стилю, не копируй
дословно):
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
