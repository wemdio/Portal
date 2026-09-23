/** @jest-environment node */

/**
 * По description гипотезы потом отбирают компании. Генератор писал рабочие
 * детали признаками покупателя («производители … с Меркурием», «фабрики …
 * со сменами, складами сырья и поставками в федеральные сети», «с наймом
 * рабочих»), и проверка релевантности откладывала компании нужного вида
 * деятельности, у которых этого нет на сайте.
 */
import { buildHypothesesInstantMessages, type HypothesesPromptInput } from '@/lib/verticalEngineV2/prompts/hypotheses';
import { buildHypothesesInstantMessagesEn } from '@/lib/verticalEngineV2/prompts/hypotheses.en';

const input = {
  profile: { company: 'Клиент' }, websiteUrl: 'https://client.test', brandCloud: [], competitors: [],
} as unknown as HypothesesPromptInput;

describe('VE2 hypothesis description instructions', () => {
  it('keeps processes, tools, channels, hiring and headcount out of who the buyer is (RU)', () => {
    const [system, user] = buildHypothesesInstantMessages(input).map((message) => message.content);
    expect(system).toContain('Сначала — кто это: вид деятельности, тип компании');
    expect(system).toContain('явные условия отбора');
    expect(system).toContain('рабочие процессы, программы и госсистемы, регуляторику, склады, каналы продаж и найм НЕ пиши признаками компании');
    expect(system).toContain('Затем отдельной фразой — какую боль клиента решает продукт');
    // Size is ranking, not selection: the relevance check never sees the headcount.
    expect(system).toContain('Численность, выручку и объёмы тоже НЕ делай условием отбора');
    expect(system).not.toContain('если они нужны («сеть от 5 точек», «от 200 сотрудников»)');
    expect(user).toContain('процессы, системы, каналы, найм и численность — не признаки компании');
  });

  it('keeps processes, tools, channels, hiring and headcount out of who the buyer is (EN)', () => {
    const [system, user] = buildHypothesesInstantMessagesEn(input).map((message) => message.content);
    expect(system).toContain('First who they are: the activity, the company type');
    expect(system).toContain('explicit selection conditions');
    expect(system).toContain('do NOT write work processes, software and government systems, regulation, warehouses, sales channels or hiring as company attributes');
    expect(system).toContain('Do NOT make headcount, revenue or volume a selection condition either');
    expect(system).not.toContain('when needed ("chains of 5+ locations", "200+ employees")');
    expect(user).toContain('processes, systems, channels, hiring and headcount are not company attributes');
  });
});
