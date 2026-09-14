import { UNIVERSAL_REPLY_RULES } from './promptRules';
import type { KnowledgeBase, QualificationRow, ThreadMessage } from './types';

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

function formatThread(thread: ThreadMessage[]): string {
  return thread
    .map((m) => `${m.fromUs ? 'МЫ' : 'ОНИ'} (${m.timestamp ?? '—'}):\n${m.text}`)
    .join('\n\n---\n\n');
}

export function buildReplyPrompt(input: {
  kb: KnowledgeBase;
  qualification: QualificationRow;
  thread: ThreadMessage[];
  contextComplete: boolean;
}): PromptMessage[] {
  const { kb, qualification, thread, contextComplete } = input;

  const system = `${UNIVERSAL_REPLY_RULES}

О продукте/проекте, для которого пишешь письмо:

Бриф:
${kb.brief || '(бриф не заполнен)'}

Факты о продукте и что можно предлагать:
${kb.productFacts || '(факты не заполнены)'}

Тон и ограничения этого проекта:
${kb.toneNotes || '(особых ограничений нет, используй деловой тон по умолчанию)'}

Пример хорошего письма для этого проекта (ориентир по стилю, не копируй
дословно):
${kb.exampleCase || '(примера нет)'}`;

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
