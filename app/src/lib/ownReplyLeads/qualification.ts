import { getBodyText, type QualificationResult, type ThreadContext } from '@/lib/instantly/leadQualifier';
import { isEnAgencyCampaign, isOwnAgencyCampaign } from '@/lib/instantly/ownAgencyCampaign';
import { stripQuoted } from '@/lib/senderLeads/telegram';

const SERVICE_QUESTION = /^(?:(?:здравствуйте|добрый\s+(?:день|вечер)|доброе\s+утро)[!.,\s]*)?(?:подскажите,?\s*(?:пожалуйста,?\s*)?)?вы\s+хотите\s+(?:нам\s+)?предложить\s+(?:нам\s+)?(?:(?:свои|ваши)\s+)?услуги\s*\?+[\s.!]*([\s\S]*)$/iu;
// Узкий список частей подписи для известного ответа офис-менеджера. Незнакомый
// хвост оставляем ИИ: после подписи может быть живой запрос, в том числе P.S.
const SIGNATURE_PART = /^(?:офис[-\s]?менеджер|(?:ООО|АО|ПАО|ЗАО|ОАО)\s+[«"][^«»"\n]{2,100}[»"]|(?:почта|e-?mail)\s*:\s*[^\s@]+@[^\s@]+\.[^\s@]+|(?:сайт\s*:\s*)?(?:https?:\/\/|www\.)[^\s<>]+|(?:тел(?:ефон)?\.?|моб\.?)\s*(?:(?:офис|моб)\.?\s*)?:\s*\+?\d[\d ()-]{5,30}\d)(?=\s|$)/iu;

function isServiceQuestionOnly(body: string): boolean {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const quotedAt = lines.findIndex(line => line.trim().startsWith('>'));
  // При ответе между/под цитатами не отбрасываем возможное продолжение клиента.
  if (quotedAt >= 0 && lines.slice(quotedAt + 1).some(line => line.trim() && !line.trim().startsWith('>'))) return false;
  // Убираем цитату, но сохраняем подпись и дополнения под ней. Общий authored-
  // парсер отбрасывает всё после подписи и мог бы скрыть настоящий интерес.
  const match = SERVICE_QUESTION.exec(stripQuoted(body).replace(/\u00a0/g, ' ').trim());
  if (!match) return false;
  let tail = match[1].trim();
  if (!tail) return true;
  if (!/^с\s+уважением(?:[,.!]|\s|$)/iu.test(tail)) return false;
  tail = tail.replace(/^с\s+уважением[,.!]?\s*/iu, '');
  while (tail) {
    const part = SIGNATURE_PART.exec(tail);
    if (!part) return false;
    tail = tail.slice(part[0].length).trim();
  }
  return true;
}

/** Исключение Polza RU имеет приоритет даже над кастомным «просят объяснить». */
export function applyOwnRuReplyPolicy(
  campaignName: string | null | undefined,
  context: ThreadContext,
  result: QualificationResult,
): QualificationResult {
  if (!isOwnAgencyCampaign(campaignName) || isEnAgencyCampaign(campaignName) ||
      !isServiceQuestionOnly(getBodyText(context.replyEmail.body))) return result;
  return {
    ...result,
    isLead: false,
    customCriteriaMatched: false,
    nonLeadKind: 'intro_request',
    ownApplicationQuote: null,
    interestSignals: [],
    reason: 'Получатель только уточняет, хотим ли мы предложить услуги. Такой вопрос сам по себе не подтверждает интерес и не передаётся в продажи.',
    needsReview: false,
    objectionHandleable: false,
    objectionDraft: null,
  };
}
