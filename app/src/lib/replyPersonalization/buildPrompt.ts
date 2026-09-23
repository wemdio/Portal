import type { CampaignStepText } from './campaignSequence';
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

function formatCampaignSteps(steps: CampaignStepText[]): string {
  if (!steps.length) return '(письма цепочки получить не удалось — опирайся на бриф и переписку)';
  return steps
    .map((s) => `Письмо ${s.step}${s.subject ? ` (тема: ${s.subject})` : ''}:\n${s.body}`)
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
  /** Правила письма из глобальных настроек (правит админ); пусто — стандартные из кода. */
  systemPrompt?: string;
  /** Бриф проекта живьём из карточки (projects.brief_text), не из базы знаний. */
  brief: string;
  qualification: QualificationRow;
  thread: ThreadMessage[];
  contextComplete: boolean;
  /** Письма цепочки кампании по порядку; пусто — не удалось получить. */
  campaignSteps?: CampaignStepText[];
  /** Новый контакт, на которого перенаправил адресат; null — ответ в ту же переписку. */
  recipientEmail?: string | null;
}): PromptMessage[] {
  const { kb, globalKb, brief, qualification, thread, contextComplete } = input;
  const recipientEmail = input.recipientEmail ?? null;
  const rules = input.systemPrompt?.trim() || UNIVERSAL_REPLY_RULES;

  const toneNotes = preferProject(kb.toneNotes, globalKb.toneNotes);
  const exampleCase = preferProject(kb.exampleCase, globalKb.exampleCase);
  // Поля фактов в форме больше нет (всё есть в брифе) — блок попадает в
  // промпт, только если у проекта осталось старое заполненное значение.
  const productFacts = kb.productFacts.trim()
    ? `\nДополнительные факты о продукте:\n${kb.productFacts}\n`
    : '';

  const system = `${rules}

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
Письма нашей цепочки в этой кампании:

${formatCampaignSteps(input.campaignSteps ?? [])}

Переписка:

${formatThread(thread)}

${recipientEmail
    ? `Адресат перенаправил нас к новому контакту: ${recipientEmail}. Напиши письмо НОВОМУ контакту — оно уйдёт на ${recipientEmail}, а не тому, кто ответил. Это первое письмо этому человеку: начни с того, кто перенаправил, дальше — предложение из цепочки под эту компанию.`
    : `Напиши следующий ответ от НАС адресату, отвечая на его последнюю реплику.
Ответ уйдёт на ${qualification.leadEmail} в эту же переписку.`}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
