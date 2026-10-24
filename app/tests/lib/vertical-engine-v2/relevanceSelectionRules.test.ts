/** @jest-environment node */

/**
 * Правила отбора в проверке релевантности (22.09.2026).
 *
 * Сотни компаний нужного вида деятельности стояли в needs_review: смысловая
 * проверка читала рабочие детали гипотезы («с Меркурием», «со сменами,
 * складами сырья и поставками в федеральные сети», «с наймом рабочих») и
 * описание вертикали («единый стандарт приветствия») как условия отбора.
 * Тексты гипотез и вертикалей ниже — настоящие, из разобранных баз прода.
 * Поведение моделей эти тесты не проверяют (его мерили отдельно на сохранённых
 * доказательствах); они фиксируют, что именно уходит в модели, и одноразовую
 * перепроверку сохранённого резерва после смены правил.
 */
import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import type { VeRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { VE_RELEVANCE_RULES_VERSION, isVeRelevanceReady } from '@/lib/verticalEngineV2/relevanceDecision';
import { buildVeRelevanceReviewBatch, needsVeRelevanceEvidence, veSavedReviewSignature } from '@/lib/verticalEngineV2/relevanceReserve';
import { canResumePartialPreview, veSavedRelevanceScope } from '@/lib/verticalEngineV2/collectionRecovery';
import { createVeCollectionAudienceSnapshot } from '@/lib/verticalEngineV2/sourceAudience';
import { isVeRelevanceTriageEnabled } from '@/lib/verticalEngineV2/relevanceTriageConfig';
import { resetVeTriageState, veScopedTriageRubric, veTriageRubricMessages } from '@/lib/verticalEngineV2/relevanceTriage';
import { VE_RELEVANCE_TARGET_RULES, veStaffingScopeNote, relevanceReviewMessages } from '@/lib/verticalEngineV2/relevanceReview';
import { veRelevanceGeographyFacts, veRelevanceGeographySourceRows, hasVeGeographyEvidence } from '@/lib/verticalEngineV2/relevanceGeography';
import { readRelevanceCheckpoint, relevanceHash } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import type { VeRelevanceDecision } from '@/lib/verticalEngineV2/relevanceDecision';
import savedBeforeRelease from './fixtures/relevanceCheckpointBeforeRulesV2.json';
import { veMedicalScopeNote } from '@/lib/verticalEngineV2/relevanceMedical';
import { veHasStaffingOnlyRefusal } from '@/lib/verticalEngineV2/staffingCorrection';
import { deriveVeRetailAudienceScope, veRetailSourceProfileForScope } from '@/lib/verticalEngineV2/legacyRetailAudience';

const FOOD = { verticalName: 'Пищевые заводы',
  verticalSummary: 'Производители пищевой и кормовой продукции с рецептурами, партиями, сроками годности, ветсертификацией и поставками в сети; решение обычно у операционного директора, директора по производству или ИТ-директора. Покупают продукт клиента, чтобы управлять рецептурами, прослеживаемостью, сменами, складами сырья и выпуском.' };
const HYPOTHESES = {
  meat: { ...FOOD, hypothesisTitle: 'Мясопереработка',
    hypothesisDescription: 'Производители колбас, мясных полуфабрикатов, охлажденного мяса и деликатесов с Меркурием и сложной прослеживаемостью партий.' },
  confectionery: { ...FOOD, hypothesisTitle: 'Кондитерские фабрики',
    hypothesisDescription: 'Крупные производители конфет, шоколада, печенья и снеков с рецептурами, сменами, складами сырья и поставками в федеральные сети.' },
  restaurants: { verticalName: 'Рестораны и кофейни',
    verticalSummary: 'Сетевые кофейни, рестораны, QSR и casual dining; ЛПР — операционный директор, директор по качеству или руководитель сети. Покупают продукт для единого стандарта приветствия, рекомендаций, апсейла, комбо и программ лояльности во всех точках.',
    hypothesisTitle: 'Ресторанные холдинги',
    hypothesisDescription: 'Сети ресторанов, QSR и casual dining от 5 точек: контроль приветствия, рекомендаций, апсейла блюд, напитков и программ лояльности.' },
  industry: { verticalName: 'Промышленные производители',
    verticalSummary: 'Крупные производственные, сырьевые, фармацевтические, аграрные и пищевые компании. ЛПР — HR-директора и руководители подбора, которым нужно закрывать рабочих, инженеров, технологов, R&D, качество, HSE и коммерческие роли.',
    hypothesisTitle: 'Промышленное производство',
    hypothesisDescription: 'Производители металла, химии, техники, FMCG и компонентов с наймом рабочих, инженеров, технологов и коммерческих ролей.' },
  // The title defines the company by its customers: they are its activity, not context.
  horeca: { verticalName: 'Поставщики для HoReCa',
    verticalSummary: 'Компании, продающие ресторанам, кафе и отелям продукты, кофе, посуду, оборудование и расходники; ЛПР — собственник, коммерческий директор или руководитель продаж. Покупают продвижение и базы, чтобы системно находить новые заведения и сети для регулярных поставок.',
    hypothesisTitle: 'Поставщики HoReCa',
    hypothesisDescription: 'Компании, продающие продукты, кофе, посуду, оборудование и расходники ресторанам, кафе и отелям.' },
  // Consumer customers named in the title are a structural condition.
  medicalB2c: { verticalName: 'Бренды здоровья',
    verticalSummary: 'Владельцы и производители потребительских товаров для здоровья; ЛПР — бренд-, e-commerce- и маркетинг-директора. Покупают доказательный контент, отзывы, инфлюенсеров, карточки и performance для аптек, маркетплейсов и D2C-продаж.',
    hypothesisTitle: 'Медизделия B2C',
    hypothesisDescription: 'Производители тонометров, глюкометров, ортезов, тестов и home-care устройств. Нужны доверительный контент, ecom-performance, отзывы и медэкспертиза.' },
};
/** A sentence of each vertical summary that must never reach a verdict prompt. */
const SUMMARY_ONLY = {
  meat: 'Покупают продукт клиента, чтобы управлять рецептурами',
  confectionery: 'Покупают продукт клиента, чтобы управлять рецептурами',
  restaurants: 'Покупают продукт для единого стандарта приветствия',
  industry: 'ЛПР — HR-директора и руководители подбора',
  horeca: 'Покупают продвижение и базы',
  medicalB2c: 'Покупают доказательный контент',
};
// Настоящие цитаты из сохранённых доказательств разобранных баз.
const QUOTES = {
  meat: 'Выпускаем колбасы, деликатесы и полуфабрикаты под брендом "Элита Юга". Используем только натуральное сырьё, без ГМО и соевых заменителей.',
  smokehouse: 'Предприятие оснащено коптильными и сушильными печами, аппаратом сублимационной сушки и пельменным агрегатом, что позволяет нам выпускать широкий перечень продукции.',
  confectionery: 'Лихачёвский кондитерский комбинат: производство и продажа мучных кондитерских изделий оптом. Производство слоеного, песочного, сдобного печенья.',
  restaurants: 'Joy\'s Pizza 16 точек в сети Ленинский просп., 82, корп. 1 Средний чек: 1100 ₽',
  industry: 'Холдинг управляет сахарными заводами, элеваторами и молочными комбинатами.',
  horeca: 'Поставляем посуду, барное оборудование и расходники ресторанам, кафе и гостиницам.',
  medicalB2c: 'Производим тонометры и ингаляторы для дома под собственной маркой.',
  site: 'Колбасный завод «Север» выпускает варёные и копчёные колбасы, сосиски и деликатесы на собственном производстве.',
  leader: 'Цех «Лидер»: пельмени, котлеты и фарш.',
  leaderSite: 'Мясоперерабатывающий цех «Лидер» производит пельмени, котлеты, фарш и мясные полуфабрикаты для магазинов области.',
};
/** Top-level items of a comma list: commas inside parentheses stay in their item. */
function listItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0, item = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { items.push(item.trim()); item = ''; } else item += char;
  }
  return [...items, item.trim()].map((value) => value.replace(/\s*\([^)]*\)/g, '').trim());
}
const SIZE_WORDS = /headcount|employee|staff|worker|revenue|turnover|output|volume|size|сотрудник|численност|выручк|оборот/i;

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(),
  text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;
const llm = (data: unknown) => reply(200, { choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } });
const jev = (answers: Record<string, unknown>) => reply(200, { model: 'jev-1.13.0',
  choices: [{ message: { content: JSON.stringify(answers) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0 } });
const rubric = { activity: 'The company itself manufactures the target products.', requirements: [],
  conflicts: ['The company only resells products made by others.'], adjacent: [], activity_label: 'целевое производство', conflict_labels: ['перепродажа'] };

type Result = 'direct_match' | 'direct_conflict' | 'insufficient';
interface Captured { kind: 'rubric' | 'classify' | 'review' | 'repair'; model: string; system: string; user: string }
/** Requesty double. The fast check answers "uncertain"; the classifier proposes
 * every company citing its description (on the website pass: the excerpts `ids`,
 * with `status`); `review` answers the semantic check, `reviewStatus` refuses it
 * with that HTTP status, `malformed` answers it with a broken body. */
function provider(review: (model: string) => Result = () => 'direct_match',
  secondPass: { status: 'relevant' | 'irrelevant' | 'needs_review'; ids: number[] } = { status: 'relevant', ids: [0] },
  options: { reviewStatus?: number; malformed?: (user: string) => boolean; geographyQuote?: string; classifyAddress?: boolean } = {}) {
  const calls = { rubric: 0, classify: 0, deepseek: 0, confirm: 0, jev: 0, reviewed: 0, requests: [] as Captured[], jevStates: [] as unknown[] };
  global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (body.response_format?.type === 'questions') {
      calls.jev += 1;
      calls.jevStates.push(JSON.parse(body.messages[0].content));
      return jev(Object.fromEntries(Object.keys(body.response_format.questions).map((key) => [key, key === 'fit'
        ? { probabilities: { relevant: 0.3, irrelevant: 0.1, insufficient: 0.6 } } : { noul: 0.2 }])));
    }
    const system = body.messages[0].content as string, user = (body.messages[1]?.content ?? '') as string;
    if (system.startsWith('You convert ONE B2B targeting hypothesis')) {
      calls.rubric += 1; calls.requests.push({ kind: 'rubric', model: body.model, system, user });
      return llm(rubric);
    }
    if (system.startsWith('Independently check')) {
      const companies = JSON.parse(user.split('index:\n')[1]) as Array<{ i: number }>;
      if (body.model === 'openai/gpt-5-mini') calls.confirm += 1; else calls.deepseek += 1;
      calls.reviewed += companies.length;
      calls.requests.push({ kind: 'review', model: body.model, system, user });
      if (options.reviewStatus) return reply(options.reviewStatus, {});
      if (options.malformed?.(user)) return llm({ reviews: 'нет ответа' });
      return llm({ reviews: companies.map((item) => ({ i: item.i, result: review(body.model), reason: 'Проверено по цитатам',
        ...(options.geographyQuote !== undefined ? { geography_evidence: [{ field: 'address', quote: options.geographyQuote }] } : {}) })) });
    }
    if (system.startsWith('Repair citations')) {
      calls.requests.push({ kind: 'repair', model: body.model, system, user });
      return llm({ evidence_ids: [] });
    }
    calls.classify += 1; calls.requests.push({ kind: 'classify', model: body.model, system, user });
    const batch = JSON.parse(user.split(/Rows, local indices [^\n]*:\n/)[1]) as Array<{ i: number; description: string; address?: string }>;
    if (system.includes('Independent second look')) {
      return llm({ decisions: batch.map((item) => ({ i: item.i, status: secondPass.status,
        reason: secondPass.status === 'relevant' ? 'Производство по сайту' : 'По сайту видны признаки производства, но деталей мало.',
        evidence_ids: secondPass.ids })) });
    }
    return llm({ decisions: batch.map((item) => ({ i: item.i, status: 'relevant', reason: 'Собственное производство',
      evidence: [{ field: 'description', quote: item.description },
        ...(options.classifyAddress && item.address ? [{ field: 'address', quote: item.address }] : [])] })) });
  }) as unknown as typeof fetch;
  return calls;
}
const offline = () => jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'offline' });
/** The checkpoint as saved before this release: no rules marks anywhere. */
function beforeRelease(checkpoint: VeRelevanceCheckpoint): VeRelevanceCheckpoint {
  const legacy = structuredClone(checkpoint);
  for (const review of Object.values(legacy.semantic_reviews)) delete (review as { rules?: number }).rules;
  for (const verdict of Object.values(legacy.verdicts)) delete (verdict as { rules_version?: number }).rules_version;
  return legacy;
}
const keyOf = (checkpoint: VeRelevanceCheckpoint, quote: string) =>
  Object.values(checkpoint.semantic_reviews).find((review) => review.proposal.evidence.some((item) => item.quote === quote))!.company_key;
const REVIEW_ATTEMPT = relevanceHash(['automatic', 'verified-website-reader-v4']);

describe('VE2 relevance selection rules', () => {
  const env = { ...process.env };
  beforeEach(() => {
    resetVeTriageState();
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
    delete process.env.VE_MODEL_GATE; delete process.env.VE_MODEL_RELEVANCE_REVIEW;
    delete process.env.VE_RELEVANCE_TRIAGE; delete process.env.VE_RELEVANCE_TRIAGE_PROJECTS;
  });
  afterEach(() => { process.env = { ...env }; });

  it('requires company-specific geography evidence even when every activity verdict is positive', async () => {
    const calls = provider(() => 'direct_match', undefined, { geographyQuote: 'Москва, ул. Примерная, 10' });
    const rows = [
      { company: 'Столичный завод', inn: '7701000001', email: 'hello@capital.example', description: QUOTES.meat, address: 'Москва, ул. Примерная, 10' },
      { company: 'Тульский завод', inn: '7101000001', email: 'hello@tula.example', description: QUOTES.meat, address: 'Тульская область, Тула, ул. Заводская, 1' },
      { company: 'Без адреса', inn: '7801000001', email: 'hello@unknown.example', description: QUOTES.meat },
    ];
    const fetchEvidence = offline();
    const input = { ...HYPOTHESES.meat, rows, language: 'ru' as const, geography: 'Москва и МО', fetchEvidence, allowPaidSearch: false };
    const result = await findIrrelevantRows(input);
    expect(result.decisions.get(0)?.status).toBe('relevant');
    expect(result.decisions.get(1)?.status).not.toBe('relevant');
    expect(result.decisions.get(2)?.status).not.toBe('relevant');
    for (const request of calls.requests.filter((item) => item.kind === 'review' || item.kind === 'classify')) {
      expect(request.system).toContain('MANDATORY COLLECTION GEOGRAPHY');
      expect(request.user).toContain('Москва и МО');
    }
    const firstReview = calls.requests.find((item) => item.kind === 'review')!;
    expect(firstReview.user).toContain(rows[1].address);
    expect(firstReview.user).not.toContain('hello@');
    const before = calls.requests.length;
    const resumed = await findIrrelevantRows({ ...input, checkpoint: result.checkpoint });
    expect(resumed.decisions.get(0)?.status).toBe('relevant');
    expect(calls.requests.length).toBe(before); // deployment/retry cannot re-buy unchanged verdicts

    // A complete short address is valid proof, not a truncated activity quote:
    // retaining it must not buy a citation repair or website call.
    const shortCalls = provider(() => 'direct_match', undefined, { geographyQuote: 'Омск', classifyAddress: true });
    const shortFetch = offline();
    const short = await findIrrelevantRows({ ...input, rows: [{ ...rows[0], address: 'Омск' }],
      geography: 'Омск', fetchEvidence: shortFetch });
    expect(short.decisions.get(0)?.status).toBe('relevant');
    expect(shortCalls.requests.some((request) => request.kind === 'repair')).toBe(false);
    expect(shortFetch).not.toHaveBeenCalled();
  });

  it('keeps legacy geography-free caches intact but cannot reuse them for a constrained review', async () => {
    const calls = provider();
    const row = { company: 'Завод', inn: '7701000001', email: 'hello@example.test', description: QUOTES.meat };
    const input = { ...HYPOTHESES.meat, rows: [row], language: 'ru' as const, fetchEvidence: offline(), allowPaidSearch: false };
    const legacy = await findIrrelevantRows(input);
    expect(legacy.decisions.get(0)?.status).toBe('relevant');
    const count = calls.requests.length;
    const unchanged = await findIrrelevantRows({ ...input, checkpoint: legacy.checkpoint, geography: null });
    expect(unchanged.checkpoint?.context_hash).toBe(legacy.checkpoint?.context_hash);
    expect(calls.requests.length).toBe(count);
    const constrained = await findIrrelevantRows({ ...input, checkpoint: legacy.checkpoint, geography: 'Москва и МО' });
    expect(constrained.checkpoint?.context_hash).not.toBe(legacy.checkpoint?.context_hash);
    expect(constrained.decisions.get(0)?.status).not.toBe('relevant'); // positive label without geographic proof is insufficient
  });

  it('keeps location facts separate from activity and never infers company geography from vacancies or INN', () => {
    expect(veRelevanceGeographyFacts([{ inn: '7701000001', vacancy_area: 'Москва', company: 'Москва завод', website: 'moscow.example' }])).toBe('');
    expect(veRelevanceGeographyFacts([{ source_detail: 'hh: менеджер', address: 'Москва' }])).toBe('');
    expect(veRelevanceGeographyFacts([{ source_detail: 'реестр\nhh: менеджер', address: 'Казань\nМосква' }])).toBe('');
    expect(veRelevanceGeographyFacts([{ source_detail: 'реестр\nhh: менеджер', address: 'Казань\nМосква' },
      { source_detail: 'реестр', address: 'Казань' }])).toBe('Казань');
    const recipient = { company: 'Завод', inn: '7701000001', website: 'factory.test', email: 'hello@factory.test',
      address: 'Казань\nМосква', source_detail: 'реестр\nhh: менеджер' };
    const saved = veRelevanceGeographySourceRows([recipient], [recipient,
      { ...recipient, source_detail: 'реестр', address: 'Казань', description: 'Производим снеки' },
      { ...recipient, inn: '7701000002', source_detail: 'реестр', address: 'Тула' },
      { company: 'Завод', source_detail: 'реестр', address: 'Омск' }]);
    expect(saved).toEqual([{ company: 'Завод', inn: '7701000001', website: 'factory.test',
      address: 'Казань', source_detail: 've:geography-source', _ve_geography_source: true }]);
    expect(veRelevanceGeographySourceRows([recipient], saved)).toEqual(saved);
    expect(veRelevanceGeographyFacts([recipient, ...saved])).toBe('Казань');
    expect(hasVeGeographyEvidence('Омск', [{ field: 'address', quote: 'Омск' }], { address: 'Омск', evidence: [] })).toBe(true);
    expect(veRelevanceGeographyFacts([{ address: 'Московская область, Химки' }, { address: 'Московская область, Химки' }]))
      .toBe('Московская область, Химки');
    expect(hasVeGeographyEvidence('Москва', [{ field: 'address', quote: 'Москва' }], { address: 'Тула', evidence: [] })).toBe(false);
    for (const [required, quote] of [
      ['Казахстан', 'Офис в Казахстане, город Алматы'], ['Беларусь', 'Наш офис в Беларуси'],
      ['Украина', 'Адрес офиса в Украине'], ['Грузия', 'Компания зарегистрирована в Грузии'],
      ['Кыргызстан', 'Филиал в Кыргызстане'], ['Узбекистан', 'Офис в Узбекистане'],
      ['Армения', 'Наш офис в Армении'], ['Азербайджан', 'Филиал в Азербайджане'],
    ]) expect(hasVeGeographyEvidence(required, [{ field: 'address', quote }], { address: quote, evidence: [] })).toBe(true);
    for (const [required, quote] of [
      ['Казахстан', 'Москва, Казахстанская улица, 10'], ['Беларусь', 'Москва, Белорусская улица, 10'],
      ['Украина', 'Москва, Украинский бульвар, 10'], ['Грузия', 'Москва, Большая Грузинская улица, 10'],
      ['Армения', 'Москва, Армянский переулок, 10'],
    ]) expect(hasVeGeographyEvidence(required, [{ field: 'address', quote }], { address: quote, evidence: [] })).toBe(false);
    for (const [required, quote] of [['Москва и МО', 'Московская обл., Химки'], ['Москва', 'Офис в Москве'],
      ['Новосибирск', 'Офис в Новосибирске'], ['СПб и ЛО', 'Ленинградская область'], ['Казань', 'Офис в Казани'],
      ['Россия', 'Тульская область'], ['Россия', 'Казань'], ['Россия', 'Российская Федерация'], ['МО', 'Подмосковье']]) {
      expect(hasVeGeographyEvidence(required, [{ field: 'address', quote }], { address: quote, evidence: [] })).toBe(true);
    }
    for (const [required, quote] of [['Москва и МО', 'Производим снеки'], ['Москва', 'Московская область'],
      ['Москва', 'Moscow region'], ['Москва', 'Московский проспект'], ['Москва и МО', 'Тульская область'],
      ['Новосибирск', 'Новосибирская область'], ['МО', 'Москва'], ['Казань', 'Республика Татарстан']]) {
      expect(hasVeGeographyEvidence(required, [{ field: 'website_text', quote }],
        { evidence: [{ field: 'website_text', quote }] })).toBe(false);
    }
    const messages = relevanceReviewMessages('Target hypothesis: заводы', [{ evidence: [{ field: 'category', quote: 'Пищевое производство' }], address: 'Тула' }], 'ru', undefined,
      { version: 1, kind: 'sector', any_of: ['Производители продуктов'], required: [], excluded: [] }, 'Москва и МО');
    expect(messages[0].content).toContain('additional buyer requirement');
    expect(messages[1].content).toContain('Москва и МО');
    expect(messages[1].content).toContain('Тула');
  });

  it('corrects only the audited generated retail scopes and preserves explicit conditions and exclusions', () => {
    const materials = { origin: 'generated' as const, title: 'Производители строительно-отделочных материалов',
      description: 'Заводы сухих смесей, напольных покрытий, плитки и ЛКМ с собственным шоурумом и интернет-магазином. Потеря прямых частных заказов при передаче их сторонним дилерам.' };
    const jewelry = { origin: 'generated' as const, title: 'Ювелирные заводы и сети украшений',
      description: 'Производители золотых и серебряных украшений с фирменной розницей и интернет-витриной. Сложность удержания клиента между покупками к праздничным датам.' };
    const initial = structuredClone([materials, jewelry]);
    const materialScope = deriveVeRetailAudienceScope(materials)!;
    const jewelryScope = deriveVeRetailAudienceScope(jewelry)!;
    expect(materialScope.any_of).toEqual([
      'Производители сухих строительных смесей', 'Производители напольных покрытий',
      'Производители плитки', 'Производители лакокрасочных материалов',
    ]);
    expect(jewelryScope.any_of).toEqual([
      'Производители ювелирных изделий из золота или серебра',
      'Розничные сети ювелирных украшений из золота или серебра',
    ]);
    expect(jewelryScope.excluded).toEqual(expect.arrayContaining([
      'Компании, занимающиеся только ремонтом ювелирных изделий без производства или розничной сети',
      'Ломбарды и скупщики ювелирных изделий',
      'Производители и продавцы только бижутерии, без ювелирных изделий из золота или серебра',
    ]));
    expect(veScopedTriageRubric(jewelryScope).requirements).toEqual([]);
    expect(veScopedTriageRubric(jewelryScope).activity).toContain('(OR, not AND)');
    expect(veScopedTriageRubric(jewelryScope).conflicts.join(' ')).toContain('Ломбарды');
    expect(veRetailSourceProfileForScope(materialScope, 'generated')).toBe('material_manufacturers');
    expect(veRetailSourceProfileForScope(jewelryScope, 'generated')).toBe('jewelry_manufacturers_or_chains');
    for (const hypothesis of [materials, jewelry]) {
      expect(deriveVeRetailAudienceScope({ ...hypothesis, origin: 'manual' })).toBeNull();
      expect(deriveVeRetailAudienceScope({ ...hypothesis, origin: undefined })).toBeNull();
      expect(deriveVeRetailAudienceScope({ ...hypothesis, description: hypothesis.description + ' Только Москва.' })).toBeNull();
      expect(deriveVeRetailAudienceScope({ ...hypothesis, description: hypothesis.description + ' Обязателен интернет-магазин.' })).toBeNull();
      expect(deriveVeRetailAudienceScope({ ...hypothesis, audience_scope: jewelryScope })).toBeNull();
      expect(() => deriveVeRetailAudienceScope({ ...hypothesis, audience_scope: { ...jewelryScope, version: 2 } as never })).toThrow();
    }
    expect(veRetailSourceProfileForScope(jewelryScope, 'manual')).toBeNull();
    expect(veRetailSourceProfileForScope({ ...jewelryScope, required: ['Обязательно собственное производство и розничная сеть'] })).toBeNull();
    expect(veRetailSourceProfileForScope({ ...jewelryScope, excluded: [...jewelryScope.excluded, 'Москва'] })).toBeNull();
    expect(veRetailSourceProfileForScope({ ...jewelryScope, any_of: [...jewelryScope.any_of, 'Магазины одежды'] })).toBeNull();
    expect(veRetailSourceProfileForScope({ ...jewelryScope, any_of: [jewelryScope.any_of[0]] })).toBeNull();
    expect(veRetailSourceProfileForScope({ ...jewelryScope, any_of: [...jewelryScope.any_of].reverse() })).toBe('jewelry_manufacturers_or_chains');
    expect([materials, jewelry]).toEqual(initial);
    materialScope.any_of.push('Чужой вид деятельности');
    expect(deriveVeRetailAudienceScope(materials)!.any_of).toHaveLength(4);
  });

  it('uses the frozen structured policy in every check, keeps explicit requirements and separates saved verdicts', async () => {
    const audienceScope = { version: 1 as const, kind: 'sector' as const, any_of: ['Fintech platforms', 'Payment providers'],
      required: ['At least 200 employees', 'Uses ERP', 'Hires engineers'], excluded: ['Insurance agencies'] };
    const base = { rows: [{ company: 'Company', description: QUOTES.meat }], verticalName: 'Seller context must not narrow',
      hypothesisTitle: 'Misleading narrow title', hypothesisDescription: 'Old description', language: 'ru' as const,
      fetchEvidence: offline(), websiteLimit: 0, audienceScope };
    const calls = provider(() => 'insufficient');
    const checked = await findIrrelevantRows({ ...base, triage: true });
    expect(checked.decisions.get(0)?.status).not.toBe('relevant');
    expect(calls.rubric).toBe(0);
    expect(calls.requests.map(request => request.kind)).toEqual(expect.arrayContaining(['classify', 'review']));
    for (const request of calls.requests) {
      expect(request.system).toContain('STRUCTURED AUDIENCE v1');
      expect(request.system).toContain('any_of is OR');
      expect(request.system).toContain('required is AND');
      expect(request.system).not.toContain('CONTEXT and never a requirement');
      expect(request.system).not.toContain('minimum number of locations ("from 5") is not checked');
      for (const requirement of [...audienceScope.required, ...audienceScope.excluded]) expect(request.user).toContain(requirement);
      expect(request.user).not.toContain('Old description');
    }
    const savedCount = calls.classify + calls.deepseek + calls.confirm;
    await findIrrelevantRows({ ...base, triage: true, checkpoint: checked.checkpoint });
    expect(calls.classify + calls.deepseek + calls.confirm).toBe(savedCount);
    const different = await findIrrelevantRows({ ...base, audienceScope: { ...audienceScope, required: ['Uses ERP'] }, checkpoint: checked.checkpoint });
    expect(different.checkpoint.context_hash).not.toBe(checked.checkpoint.context_hash);
    const beforeInvalid = calls.classify + calls.deepseek + calls.confirm;
    await expect(findIrrelevantRows({ ...base, audienceScope: { ...audienceScope, version: 2 } as never })).rejects.toThrow();
    expect(calls.classify + calls.deepseek + calls.confirm).toBe(beforeInvalid);

    const hypothesis = { id: 'h1', title: 'B2B SaaS с remote-командами',
      description: 'SaaS-вендоры, нанимающие разработчиков в 2+ странах.', origin: 'generated' as const, status: 'accepted' };
    const legacyScope = veSavedRelevanceScope({ hypotheses: [hypothesis] }, 'h1');
    const scoped = veSavedRelevanceScope({ audience_snapshot: createVeCollectionAudienceSnapshot([
      { ...hypothesis, audience_scope: { ...audienceScope, any_of: ['B2B SaaS'], required: ['Найм в 2+ странах'] } },
    ], 'new_preview', '2026-10-15T00:00:00Z') }, 'h1');
    const saved = { company: 'SaaS', website: 'https://saas.test', email: 'info@saas.test', _email_status: 'ok',
      _ve_relevance: { status: 'needs_review', reason: 'Не подтверждён найм в 2+ странах.',
        website_review_version: 4, rules_version: VE_RELEVANCE_RULES_VERSION, review_attempts: 2 } };
    const batch = { reserve: [saved], ready: [], source: [], automatic: true, allowPaidSearch: false, triage: false };
    expect(buildVeRelevanceReviewBatch({ ...batch, ...legacyScope }).rows).toHaveLength(1);
    expect(buildVeRelevanceReviewBatch({ ...batch, ...scoped }).rows).toHaveLength(0);
    expect(JSON.stringify(veSavedReviewSignature([saved], { ...scoped, triage: false }))).not.toContain('staffing_pending');
    const pending = { ...saved, _ve_relevance: { ...saved._ve_relevance, website_review_version: undefined, review_attempts: 0 } };
    expect(buildVeRelevanceReviewBatch({ ...batch, ...scoped, reserve: [pending] }).rows).toHaveLength(1);

    // 15.10.2026: a ski venue's cash desk was admitted to fintech solely from
    // the maps rubric «Платёжные терминалы». Device locations are not providers.
    const paymentRows = [
      { company: 'Касса', website: 'https://ski.test', category: 'Бытовые услуги / Бытовые услуги, Платёжные терминалы',
        description: 'Горнолыжный комплекс: подъёмники, инструкторы и прокат.' },
      { company: 'Банкомат', website: 'https://atm.test', category: 'Бизнес / Финансы, Банкоматы', description: '' },
      { company: 'Terminal', website: 'https://terminal.test', category: 'Payment terminals', description: '' },
      { company: 'PSP', website: 'https://psp.test', category: 'Платёжные терминалы',
        description: 'Предоставляем платёжный API, интернет-эквайринг и обработку платежей для бизнеса.' },
      { company: 'Bank', website: 'https://bank.test', category: 'Банк', description: '' },
      { company: 'Manufacturer', website: 'https://manufacturer.test', category: 'Платёжные терминалы',
        description: 'Производим платёжные терминалы и собственное программное обеспечение для них.' },
    ];
    const paymentFetch = jest.fn(async (_url: unknown, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0].content, user = body.messages[1].content;
      if (system.startsWith('Independently check')) {
        const companies = JSON.parse(user.split('index:\n')[1]) as Array<{ i: number }>;
        return llm({ reviews: companies.map(({ i }) => ({ i, result: 'direct_match', reason: 'Деятельность подтверждена.' })) });
      }
      const companies = JSON.parse(user.split(/Rows, local indices [^\n]*:\n/)[1]) as Array<{ i: number; company: string; category: string; description: string }>;
      return llm({ decisions: companies.map((item) => ({ i: item.i, status: 'relevant', reason: 'Платёжные услуги.',
        evidence: item.description && !item.description.startsWith('Горнолыжный') ? [{ field: 'description', quote: item.description }]
          : [{ field: 'category', quote: item.category }] })) });
    });
    global.fetch = paymentFetch as unknown as typeof fetch;
    const paymentSites = offline();
    const paymentInput = { ...base, audienceScope: { ...audienceScope, required: [], excluded: [] },
      rows: paymentRows, fetchEvidence: paymentSites, websiteLimit: 32, allowPaidSearch: true };
    const payment = await findIrrelevantRows(paymentInput);
    expect([...payment.decisions.values()].map((decision) => decision.status))
      .toEqual(['needs_review', 'needs_review', 'needs_review', 'relevant', 'relevant', 'relevant']);
    expect(paymentFetch).toHaveBeenCalledTimes(3); // one classifier and only the three supported companies reviewed twice
    expect(paymentSites).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) {
      const decision = payment.decisions.get(i)!;
      expect(decision).toMatchObject({ activity_evidence_guard: 'payment_point_category' });
      const oldAdmission = { ...decision, status: 'relevant' as const };
      delete oldAdmission.activity_evidence_guard; delete oldAdmission.activity_evidence_guard_input; delete oldAdmission.activity_evidence_guard_facts;
      expect(isVeRelevanceReady({ ...paymentRows[i], _ve_relevance: oldAdmission })).toBe(false);
      const guarded = { ...paymentRows[i], email: 'info@example.test', _email_status: 'ok', _ve_relevance: decision };
      expect(needsVeRelevanceEvidence(guarded)).toBe(false);
      expect(buildVeRelevanceReviewBatch({ reserve: [guarded], ready: [], source: [], automatic: true, triage: true }).rows).toHaveLength(0);
    }
    for (const i of [3, 4, 5]) expect(isVeRelevanceReady({ ...paymentRows[i], _ve_relevance: payment.decisions.get(i) })).toBe(true);
    // Free downgrade of a saved admission, with a completed receipt or even a
    // missing receipt: preserve every paid attempt; neither semantic nor site work is purchased.
    const oldPayment = structuredClone(payment.checkpoint);
    for (let i = 0; i < 3; i++) {
      const key = payment.decisions.get(i)!.activity_evidence_guard_input!;
      const verdict = oldPayment.verdicts[key];
      verdict.status = 'relevant'; delete verdict.activity_evidence_guard; delete verdict.activity_evidence_guard_input; delete verdict.activity_evidence_guard_facts;
      if (i === 0) {
        const ref = relevanceHash(['old-terminal-receipt', key]);
        oldPayment.semantic_review_refs[key] = ref;
        oldPayment.semantic_reviews[ref] = { company_key: key, proposal: structuredClone(verdict), status: 'finished',
          attempts: 2, result: { result: 'direct_match', reason: 'По рубрике' } };
        // A spent website receipt cannot erase the free hold at final projection.
        oldPayment.website_evidence[key] = { reader_version: 1, status: 'unavailable', text: '', url: '', reason: 'provider_error',
          provider_error: { kind: 'transient', message: 'upstream unavailable' }, provider_error_attempts: 3,
          review_attempt: REVIEW_ATTEMPT, review_attempts: 1, refined: true };
      }
    }
    const receipts = structuredClone(oldPayment.semantic_reviews);
    const beforeGuard = paymentFetch.mock.calls.length;
    const downgraded = await findIrrelevantRows({ ...paymentInput, checkpoint: oldPayment });
    await findIrrelevantRows({ ...paymentInput, checkpoint: downgraded.checkpoint });
    expect(paymentFetch).toHaveBeenCalledTimes(beforeGuard);
    expect(paymentSites).not.toHaveBeenCalled();
    expect(downgraded.checkpoint.semantic_reviews).toEqual(receipts);
    // A lost checkpoint cannot re-buy the same bad evidence. New substantive
    // input changes its key and is allowed to prove a real PSP instead.
    const guardedRow = { ...paymentRows[0], _ve_relevance: downgraded.decisions.get(0) };
    expect(guardedRow._ve_relevance).toMatchObject({ activity_evidence_guard: 'payment_point_category' });
    const withoutCheckpoint = await findIrrelevantRows({ ...paymentInput, rows: [guardedRow] });
    expect(withoutCheckpoint.decisions.get(0)?.status).toBe('needs_review');
    expect(paymentFetch).toHaveBeenCalledTimes(beforeGuard);
    // Exercise the real reserve/source selector, not only a direct gate call:
    // same data (including a manual retry) is free; new activity can prove a PSP.
    const held = { ...paymentRows[2], email: 'info@terminal.test', _email_status: 'ok', _ve_relevance: downgraded.decisions.get(2) };
    const richerSource = { ...paymentRows[2], company_description: paymentRows[3].description };
    for (const automatic of [false, true]) {
      const unchanged = buildVeRelevanceReviewBatch({ reserve: [held], ready: [], source: [{ ...paymentRows[2],
        phone: '+000', source_detail: 'new diagnostics' }, { ...paymentRows[3], description: 'Other company facts' }], automatic, triage: true });
      expect(unchanged.rows).toHaveLength(0);
      const fromSource = buildVeRelevanceReviewBatch({ reserve: [held], ready: [], source: [richerSource], automatic, allowPaidSearch: false });
      expect(fromSource.companies).toBe(1);
      expect(fromSource.rows).toEqual([held]);
      expect(veSavedReviewSignature(fromSource.rows, { triage: true, source: fromSource.evidenceRows }))
        .not.toEqual(veSavedReviewSignature([held], { triage: true }));
      const changedReserve = { ...held, description: paymentRows[3].description };
      expect(buildVeRelevanceReviewBatch({ reserve: [changedReserve], ready: [], source: [], automatic }).rows).toEqual([changedReserve]);
    }
    expect(paymentFetch).toHaveBeenCalledTimes(beforeGuard);
    const selected = buildVeRelevanceReviewBatch({ reserve: [held], ready: [], source: [richerSource], automatic: true });
    const newFacts = await findIrrelevantRows({ ...paymentInput, rows: selected.rows, evidenceRows: selected.evidenceRows,
      checkpoint: withoutCheckpoint.checkpoint });
    expect(newFacts.decisions.get(0)?.status).toBe('relevant');
    expect(isVeRelevanceReady({ _ve_relevance: newFacts.decisions.get(0) })).toBe(true);
    const reviewed = { ...held, _ve_relevance: newFacts.decisions.get(0) };
    expect(buildVeRelevanceReviewBatch({ reserve: [reviewed], ready: [], source: [richerSource], automatic: true }).rows).toHaveLength(0);
  });

  it('asks every model to prove only activity, type and structural conditions, never the vertical summary', async () => {
    for (const [name, hypothesis] of Object.entries(HYPOTHESES) as Array<[keyof typeof HYPOTHESES, typeof HYPOTHESES.meat]>) {
      resetVeTriageState();
      const calls = provider();
      const checked = await findIrrelevantRows({ ...hypothesis, language: 'ru', triage: true, fetchEvidence: offline(),
        rows: [{ company: 'Компания', description: QUOTES[name] }] });
      expect(checked.decisions.get(0)?.status).toBe('relevant');
      const kinds = calls.requests.map((request) => request.kind);
      expect(kinds).toEqual(expect.arrayContaining(['rubric', 'classify', 'review']));
      for (const request of calls.requests) {
        // Pains, tools, processes, channels, hiring and service standards are named as context.
        for (const word of ['Mercury', 'traceability', 'shifts', 'raw-material warehouses', 'federal retail chains', 'hiring',
          'greeting', 'loyalty programmes', 'CONTEXT and never a requirement']) expect(request.system).toContain(word);
        // Listed products widen the title's class (snacks for confectioners), never narrow it.
        expect(request.system).toContain('widen the title\'s class and never narrow it');
        expect(request.system).toContain('any activity inside the title\'s class counts even when it is not listed');
        // The company type stays a requirement: resellers and suppliers do not become producers.
        expect(request.system).toContain('a manufacturer or producer rather than a reseller, distributor, dealer, trading house or shop');
        expect(request.system).toContain('When the hypothesis names several types ("producers and trading houses"), any of them qualifies.');
        expect(request.system).toContain('A bare list of products with neither leaves the type unproven.');
        expect(request.system).toContain('Once making is shown, the type is shown');
        // Structural conditions: network, minimum number, B2B/B2C, a channel or customer the title is defined by.
        expect(request.system).toContain('business or consumer customers as a whole (B2B, B2C)');
        // «поставки в федеральные сети» are a sales channel, not the company's own network.
        expect(request.system).toContain('retail chains it supplies are a sales channel, not its network');
        expect(request.system).toContain('that channel or customer is part of its activity and must be shown');
        expect(request.system).toContain('a network shown without a count meets it, also when the excerpts give the address of only one of its outlets');
        // «Три кафе» for «от 5 точек» keeps the company in the reserve: the website pass must not reject it for good.
        expect(request.system).toContain('that is missing evidence (needs_review, insufficient), never irrelevant or a conflict');
        // Size is not proven from excerpts (the gate never sees the registry headcount); it only excludes a micro business.
        expect(request.system).toContain('Size words such as "large"');
        expect(request.system).toContain('size figures (a minimum headcount, revenue or output) never need proof');
        expect(request.system).toContain('an evident micro business (home production, a single kiosk, a craftsman) or an explicitly stated smaller size');
        expect(request.system).not.toMatch(/a minimum headcount or size (?:stated|given) as a number/);
        // Worked examples from other industries, and no guessing from a name or a code.
        expect(request.system).toContain('"Furniture factories hiring welders and technologists" requires proof of furniture manufacturing only');
        expect(request.system).toContain('Do not infer the activity, the type or a structural condition from a bare legal or brand name (a name field, heading or signature), a registry code or general industry knowledge.');
        // «Вурнарский мясокомбинат — один из крупнейших агрохолдингов» is the company's own statement, not a bare name.
        expect(request.system).toContain('A sentence about the company that calls it a plant, factory or combine of the target products');
        // A product list under the company's single trademark is its own range («ТМ "Рощинский"» on every item).
        expect(request.system).toContain('products listed under a single trademark with no other maker named');
        // The old loophole: pains became requirements once phrased as "companies with ...".
        expect(request.system).not.toContain('unless explicitly stated as selection conditions');
        expect(request.system).not.toContain('regional distribution');
        expect(request.system).not.toContain('IS or HAS');
        expect(request.user).toContain(hypothesis.hypothesisDescription);
        expect(request.user).not.toContain(SUMMARY_ONLY[name]);
      }
      // Quotes are chosen for the activity and for each structural condition, copied exactly: a
      // shortened or merged quote fails the verbatim check and sends the company to the website pass.
      // The classifier gets the same reminder right after the hypothesis as the review.
      for (const request of calls.requests.filter((item) => item.kind === 'classify')) {
        expect(request.system).toContain('for relevant, cover the activity and the company type, plus one for each structural condition the hypothesis states');
        expect(request.system).toContain('never shortened with an ellipsis or joined from separate places');
        // On the website pass an irrelevant verdict is final: «три кафе» for «от 5 точек» was rejected there.
        expect(request.system).toContain('Fewer locations than a minimum the hypothesis states (three cafes for "from 5 locations") or a single venue is needs_review, never irrelevant');
        expect(request.user).toContain(hypothesis.hypothesisDescription + '\nVertical: ' + hypothesis.verticalName + '\nCheck only three things here:');
      }
      const review = calls.requests.find((request) => request.kind === 'review')!;
      expect(review.system).toContain('Never return insufficient only because something the rules above call context is not mentioned');
      expect(review.system).toContain('inside the class the title names or among the items the description lists');
      // The reminder sits right after the hypothesis text: the confirming model
      // otherwise looked for «Меркурий» next to «производители колбас … с Меркурием».
      // It must agree with the rules: customers in the title, B2B/B2C and «крупные» still count.
      expect(review.user).toContain(hypothesis.hypothesisDescription + '\nVertical: ' + hypothesis.verticalName
        + '\nCheck only three things here: the activity (the class the title names; the items the description lists widen it and never narrow it)');
      // It names no checklist of conditions: listing them made the confirming model demand a network,
      // a region and B2B/B2C from every factory.
      expect(review.user).toContain('a structural condition only if this hypothesis itself states one, such as "from 5 locations" or "B2C"; a condition it does not state is never checked.');
      expect(review.user).toContain('A minimum number of locations is met by the company\'s own network shown without a count; retail chains it supplies are not its network;');
      expect(review.user).toContain('When the title defines the company by a sales channel or customer, that is part of its activity and must be shown.');
      expect(review.user).toContain('Size words and figures exclude only an evident micro business or an explicitly smaller size.');
      expect(review.user).toContain('sales channels such as supplies to retail chains, marketplaces, HoReCa or export');
      // DeepSeek rejected «выпускаем 200 наименований колбас», «ТМ "Рощинский"» and «фирменные магазины» as an
      // unproven type in one run and admitted them in the next: the producer facts sit next to the hypothesis.
      expect(review.user).toContain('When the named type is only a producer, any one of these facts shows it: a verb of making (we produce, make, manufacture, process, bake)');
      // «Производители и торговые дома …»: the producer test must not reject a trading house the hypothesis names.
      expect(review.user).toContain('The type is the one this hypothesis names; when it names several ("producers and trading houses"), any of them qualifies.');
      expect(review.user).toContain('production volumes or capacity, products under its own trademark or brand or sold in its own branded shops, products listed under a single trademark with no other maker named. Any one of these facts is enough, without a verb of making on top of it.');
      expect(review.user).toContain('only a bare list of products leaves the type unproven.');
      // «Вурнарский мясокомбинат — один из крупнейших агрохолдингов Поволжья» was rejected as a bare name.
      expect(review.user).toContain('also when a sentence about the company calls it so, even with no product named ("X meat plant is one of the largest agroholdings of the region" shows a meat processor)');
      // The classifier rejected «три кафе» for «от 5 точек» on the website pass, where a rejection is final.
      expect(review.user).toContain('a stated smaller number or a single venue leaves the condition unproven, which is uncertainty (needs_review, insufficient), never irrelevant or direct_conflict.');
      expect(review.user).not.toContain('size words and pains named in it are context');
      // The calibrated per-company Jev request is unchanged: it still carries the summary.
      expect(JSON.stringify(calls.jevStates[0])).toContain(SUMMARY_ONLY[name]);
    }
    // Without a hypothesis title the vertical is the only target and keeps its summary.
    const calls = provider();
    await findIrrelevantRows({ verticalName: FOOD.verticalName, verticalSummary: FOOD.verticalSummary, language: 'ru',
      fetchEvidence: offline(), rows: [{ company: 'Компания', description: QUOTES.meat }] });
    expect(calls.requests.find((request) => request.kind === 'classify')?.user).toContain(SUMMARY_ONLY.meat);
    const medical = provider();
    await findIrrelevantRows({ verticalName: 'Медицина', hypothesisTitle: 'Остеопатические клиники',
      hypothesisDescription: 'Лицензированные центры остеопатии и мануальной терапии с несколькими врачами.',
      hypothesisOrigin: 'generated', language: 'ru', triage: true, fetchEvidence: offline(),
      rows: [{ company: 'Пример', description: 'В клинике проводят остеопатическое лечение.' }] });
    for (const kind of ['rubric', 'classify', 'review']) {
      const prompt = medical.requests.find((request) => request.kind === kind)?.user ?? '';
      expect(prompt).toContain('MEDICAL PROVIDERS:');
      expect(prompt).toContain('Do not infer an operating block merely from surgery');
    }
    for (const origin of ['manual', undefined] as const) {
      expect(veMedicalScopeNote('Target hypothesis: Остеопатические клиники', origin)).toBe('');
    }
    for (const title of ['Пищевые заводы', 'Оборудование для стоматологий', 'Платёжные сервисы для стоматологий',
      'Остеопатические клиники и детские сады', 'Обучение врачей-остеопатов']) {
      expect(veMedicalScopeNote('Target hypothesis: ' + title, 'generated')).toBe('');
    }
    for (const description of ['Обязательно с лицензией.', 'Строго от 5 врачей.', 'Только с действующей лицензией.']) {
      expect(veMedicalScopeNote('Target hypothesis: Остеопатические клиники\n' + description, 'generated')).toBe('');
    }
  });

  it('keeps the closed lists of structural conditions exact and free of size, in the rules and in the Jev checklist', () => {
    const saas = 'Target hypothesis: B2B SaaS с remote-командами\nSaaS-вендоры из СНГ, нанимающие разработчиков в 2+ странах.';
    const staffing = veStaffingScopeNote(saas, 'generated');
    expect(veStaffingScopeNote(saas)).toBe('');
    expect(veStaffingScopeNote(saas, 'manual')).toBe('');
    for (const required of ['Обязательно remote-команды', 'Только с удалёнными командами', 'Must hire in 2+ countries']) {
      expect(veStaffingScopeNote(saas + '\n' + required, 'generated')).toBe('');
    }
    expect(staffing).toContain("company's OWN remote team");
    expect(relevanceReviewMessages(saas, [], 'ru', 'generated')[1].content).toContain(staffing);
    // The seller's SaaS vertical or a B2C/hiring-provider target must not gain
    // an invented B2B customer requirement from the SaaS-specific reminder.
    for (const scope of ['Target hypothesis: B2C SaaS с remote-командами',
      'Target hypothesis: Агентства международного найма\nVertical: B2B SaaS remote',
      'Target hypothesis: B2B SaaS\nПродукты для бизнеса']) expect(veStaffingScopeNote(scope, 'generated')).toBe('');
    // Size is ranking, not selection: the gate never receives the registry headcount, so a size
    // condition would hold every company back, whatever words it is written in.
    const rules = /STRUCTURAL CONDITIONS are the only other requirements, and only when the hypothesis states them: (.+?)\. Warehouses/
      .exec(VE_RELEVANCE_TARGET_RULES)?.[1];
    expect(rules).toBeDefined();
    expect(listItems(rules!)).toEqual(['the company\'s own network or chain of locations or branches', 'an own facility named as a condition',
      'private or state ownership', 'a named region', 'business or consumer customers as a whole']);
    expect(rules).not.toMatch(SIZE_WORDS);
    const checklist = veTriageRubricMessages('Target hypothesis: Мясопереработка', 'ru')[0].content;
    const requirements = /requirements: ONLY the structural conditions from the closed list above that the hypothesis states as conditions: (.+?)\. For a network/
      .exec(checklist)?.[1];
    expect(requirements).toBeDefined();
    expect(listItems(requirements!)).toEqual(['a network of locations or branches', 'an own facility named as a condition',
      'private or state ownership', 'a named region', 'business or consumer customers']);
    expect(requirements).not.toMatch(SIZE_WORDS);
  });

  it('rechecks a pre-release rejection once from its saved quotes, without website, search or classifier', async () => {
    // A targeted SaaS correction keeps the current rules/context and the old
    // paid receipt. All providers in this test are offline doubles.
    const saas = { verticalName: 'Продуктовые IT-компании', hypothesisTitle: 'B2B SaaS с remote-командами',
      hypothesisDescription: 'SaaS-вендоры из СНГ, нанимающие разработчиков в 2+ странах.',
      hypothesisOrigin: 'generated' as const, language: 'ru' as const, triage: true };
    const saasQuote = 'Разрабатываем собственную облачную CRM-систему по подписке для бизнеса в России.';
    const saasReason = 'B2B SaaS подтверждён, но нет данных про remote-команду в 2+ странах.';
    expect(veHasStaffingOnlyRefusal(saasReason)).toBe(true);
    expect(veHasStaffingOnlyRefusal('Нет данных про удалённую команду')).toBe(true);
    for (const reason of ['Есть разработка ПО, но нет подтверждения B2B-модели и наличия remote-команд в 2+ странах.',
      'Не подтверждён SaaS-продукт или удалённые команды в 2+ странах.',
      'Не подтверждён регион компании, а также remote-команда.',
      'SaaS для найма в нескольких странах не подтверждён.']) expect(veHasStaffingOnlyRefusal(reason)).toBe(false);
    const saasRow = { company: 'Облачный продукт', website: 'https://saas-fixture.test', description: saasQuote,
      email: 'info@saas-fixture.test', _email_status: 'ok' };
    const saasSite = offline();
    provider(() => 'insufficient');
    const saasSaved = (await findIrrelevantRows({ ...saas, rows: [saasRow], fetchEvidence: saasSite })).checkpoint;
    const saasKey = keyOf(saasSaved, saasQuote), saasRef = saasSaved.semantic_review_refs[saasKey];
    saasSaved.verdicts[saasKey] = { ...saasSaved.verdicts[saasKey], reason: 'Смысловое соответствие не подтверждено: ' + saasReason,
      rules_version: 2, triage_version: 1, website_review_version: 4 };
    saasSaved.semantic_reviews[saasRef].result = { result: 'insufficient', reason: saasReason };
    const oldPaidReceipt = structuredClone(saasSaved.semantic_reviews[saasRef]);
    const saasReserve = [{ ...saasRow, _ve_relevance: saasSaved.verdicts[saasKey] }];
    for (const hypothesisOrigin of ['manual', undefined] as const) {
      expect(buildVeRelevanceReviewBatch({ ...saas, hypothesisOrigin, reserve: saasReserve, ready: [], source: [], automatic: true }).companies).toBe(0);
      const calls = provider();
      const untouched = await findIrrelevantRows({ ...saas, hypothesisOrigin, rows: saasReserve, checkpoint: saasSaved, fetchEvidence: saasSite });
      expect(untouched.decisions.get(0)).toMatchObject({ status: 'needs_review' });
      expect(untouched.decisions.get(0)?.staffing_correction_version).toBeUndefined();
      expect(calls).toMatchObject({ classify: 0, deepseek: 0, confirm: 0, rubric: 0, jev: 0 });
    }
    expect(buildVeRelevanceReviewBatch({ ...saas, reserve: saasReserve, ready: [], source: [], automatic: true, allowPaidSearch: false }).companies).toBe(1);
    expect(veSavedReviewSignature(saasReserve, { ...saas, triage: true }))
      .not.toEqual(veSavedReviewSignature(saasReserve, { triage: true }));
    expect(veSavedReviewSignature(saasReserve, { ...saas, hypothesisOrigin: 'manual', triage: true }))
      .toEqual(veSavedReviewSignature(saasReserve, { triage: true }));
    // Source enrichment changes the company's input hash; losing or changing
    // the checkpoint likewise cannot turn correction-only work into acquisition.
    for (const changed of [
      { rows: [{ ...saasReserve[0], description: saasQuote + ' Дополненное описание продукта.' }], checkpoint: saasSaved },
      { rows: saasReserve, evidenceRows: [{ ...saasRow, description: 'Дополнительные сведения о компании из HH.' }], checkpoint: saasSaved },
      { rows: saasReserve, checkpoint: undefined },
      { rows: saasReserve, checkpoint: { ...saasSaved, context_hash: 'f'.repeat(64) } },
    ]) {
      saasSite.mockClear();
      const noCalls = provider();
      const held = await findIrrelevantRows({ ...saas, ...changed, fetchEvidence: saasSite });
      expect(held.decisions.get(0)).toMatchObject({ status: 'needs_review', staffing_correction_version: 1,
        reason: saasSaved.verdicts[saasKey].reason });
      expect(noCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
      expect(saasSite).not.toHaveBeenCalled();
      const noReplay = provider();
      await findIrrelevantRows({ ...saas, ...changed, rows: changed.rows.map((row) => ({ ...row, _ve_relevance: held.decisions.get(0) })),
        checkpoint: held.checkpoint, fetchEvidence: saasSite });
      expect(noReplay).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
      expect(saasSite).not.toHaveBeenCalled();
    }
    saasSite.mockClear();
    const saasCalls = provider();
    const reservations: VeRelevanceCheckpoint[] = [];
    const fixedSaas = await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: saasSaved, fetchEvidence: saasSite,
      allowPaidSearch: false, onCheckpoint: async (value) => { reservations.push(structuredClone(value)); } });
    expect(fixedSaas.decisions.get(0)).toMatchObject({ status: 'relevant', staffing_correction_version: 1 });
    expect(saasCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 1, confirm: 1 });
    expect(saasSite).not.toHaveBeenCalled();
    const correctionRef = fixedSaas.checkpoint.semantic_review_refs[saasKey];
    expect(correctionRef).not.toBe(saasRef);
    expect(fixedSaas.checkpoint.context_hash).toBe(saasSaved.context_hash);
    expect(fixedSaas.checkpoint.semantic_reviews[saasRef]).toEqual(oldPaidReceipt);
    expect(fixedSaas.checkpoint.semantic_reviews[correctionRef]).toMatchObject({ status: 'finished', attempts: 2, staffing_correction_version: 1 });
    expect(reservations.some((saved) => saved.semantic_reviews[correctionRef]?.status === 'started'
      && saved.semantic_reviews[correctionRef]?.attempts === 1)).toBe(true);
    const saasReplay = provider();
    await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: fixedSaas.checkpoint, fetchEvidence: saasSite });
    expect(saasReplay).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
    expect(saasSite).not.toHaveBeenCalled();
    for (const tweak of [
      (saved: VeRelevanceCheckpoint) => { saved.semantic_reviews[saasRef].result!.result = 'direct_conflict'; },
      (saved: VeRelevanceCheckpoint) => { saved.semantic_reviews[saasRef].proposal.status = 'irrelevant'; },
      (saved: VeRelevanceCheckpoint) => { saved.semantic_reviews[saasRef].proposal.evidence = [{ field: 'company', quote: 'Облачный продукт' }]; },
      (saved: VeRelevanceCheckpoint) => { saved.website_evidence[saasKey].reader_version = undefined; },
      (saved: VeRelevanceCheckpoint) => { saved.website_evidence[saasKey].search_deferred = true; },
    ]) {
      const saved = structuredClone(saasSaved); tweak(saved);
      const noCalls = provider();
      const unchanged = await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: saved, fetchEvidence: saasSite });
      expect(unchanged.decisions.get(0)).toMatchObject({ status: 'needs_review', staffing_correction_version: 1 });
      expect(noCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
      expect(saasSite).not.toHaveBeenCalled();
    }
    const refusedCalls = provider();
    await expect(findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: saasSaved, fetchEvidence: saasSite,
      onCheckpoint: async () => { throw new Error('durable write refused'); } })).rejects.toThrow('durable write refused');
    expect(refusedCalls).toMatchObject({ classify: 0, deepseek: 0, confirm: 0 });
    provider(() => 'insufficient');
    const refusedSaas = await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: saasSaved, fetchEvidence: saasSite });
    expect(refusedSaas.decisions.get(0)).toMatchObject({ status: 'needs_review', staffing_correction_version: 1 });
    const refusedReplay = provider();
    await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: refusedSaas.checkpoint, fetchEvidence: saasSite });
    expect(refusedReplay).toMatchObject({ classify: 0, deepseek: 0, confirm: 0, rubric: 0, jev: 0 });
    expect(buildVeRelevanceReviewBatch({ ...saas, reserve: [{ ...saasRow, _ve_relevance: refusedSaas.decisions.get(0) }],
      ready: [], source: [], automatic: true }).companies).toBe(0);

    // Lost DB responses cannot turn a durable reservation into a fresh attempt.
    for (const stopAt of ['started', 'finished'] as const) {
      let durable: VeRelevanceCheckpoint | undefined;
      const lostCalls = provider();
      await expect(findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: saasSaved, fetchEvidence: saasSite,
        onCheckpoint: async (value) => {
          durable = structuredClone(value);
          if (value.semantic_reviews[value.semantic_review_refs[saasKey]]?.status === stopAt) throw new Error('lost save response');
        } })).rejects.toThrow('lost save response');
      expect(lostCalls).toMatchObject(stopAt === 'started' ? { deepseek: 0, confirm: 0 } : { deepseek: 1, confirm: 1 });
      const resumedCalls = provider();
      const resumed = await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: durable, fetchEvidence: saasSite });
      expect(resumed.decisions.get(0)).toMatchObject({ status: 'relevant', staffing_correction_version: 1 });
      expect(resumedCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: stopAt === 'started' ? 1 : 0 });
      expect(resumed.checkpoint.semantic_reviews[resumed.checkpoint.semantic_review_refs[saasKey]].attempts).toBe(2);
      expect(saasSite).not.toHaveBeenCalled();
    }
    const interruptedCorrection = structuredClone(fixedSaas.checkpoint);
    interruptedCorrection.semantic_reviews[correctionRef].status = 'started';
    delete interruptedCorrection.semantic_reviews[correctionRef].result;
    interruptedCorrection.verdicts[saasKey] = { ...interruptedCorrection.verdicts[saasKey], status: 'error' };
    const exhaustedCalls = provider();
    const exhaustedCorrection = await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: interruptedCorrection, fetchEvidence: saasSite });
    expect(exhaustedCorrection.decisions.get(0)).toMatchObject({ status: 'needs_review', staffing_correction_version: 1 });
    expect(exhaustedCorrection.checkpoint.semantic_reviews[correctionRef]).toMatchObject({ attempts: 2, status: 'failed' });
    expect(exhaustedCalls).toMatchObject({ classify: 0, deepseek: 0, confirm: 0 });
    expect(saasSite).not.toHaveBeenCalled();
    for (const broken of ['missing', 'wrong_company', 'old_receipt'] as const) {
      const damaged = structuredClone(interruptedCorrection);
      if (broken === 'missing') delete damaged.semantic_reviews[correctionRef];
      else if (broken === 'wrong_company') damaged.semantic_reviews[correctionRef].company_key = 'f'.repeat(64);
      else damaged.semantic_review_refs[saasKey] = saasRef;
      const calls = provider();
      const held = await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: damaged, fetchEvidence: saasSite });
      expect(held.decisions.get(0)).toMatchObject({ status: 'needs_review', staffing_correction_version: 1,
        reason: interruptedCorrection.verdicts[saasKey].reason });
      expect(calls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
      const replayCalls = provider();
      await findIrrelevantRows({ ...saas, rows: saasReserve, checkpoint: held.checkpoint, fetchEvidence: saasSite });
      expect(replayCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
      expect(saasSite).not.toHaveBeenCalled();
    }

    const input = { ...HYPOTHESES.meat, language: 'ru' as const, triage: true,
      rows: [
        // Rejected, then hidden behind a later website verdict «Сайт не дал подтверждения».
        { company: 'Элита Юга', inn: '6143000001', description: QUOTES.meat },
        // Rejected directly: no site or INN to look for.
        { company: 'Паюта', description: QUOTES.smokehouse },
      ] };
    const first = provider(() => 'insufficient');
    const fetchEvidence = offline();
    const rejected = await findIrrelevantRows({ ...input, fetchEvidence });
    expect([0, 1].map((i) => rejected.decisions.get(i)?.status)).toEqual(['needs_review', 'needs_review']);
    expect(rejected.decisions.get(0)).toMatchObject({ reason: expect.stringContaining('Сайт не дал подтверждения'),
      evidence: [], website_review_version: 4, triage_version: 1 });
    expect(rejected.decisions.get(1)?.reason).toMatch(/^Смысловое соответствие не подтверждено/);
    // A new company's rejected admission gets the established reviewer's second opinion too;
    // both refuse here, so it stays in the reserve.
    expect(first).toMatchObject({ classify: 1, deepseek: 1, confirm: 1 });
    expect(fetchEvidence).toHaveBeenCalledTimes(1);
    // Decided under the current rules: stamped, not selected again.
    expect([0, 1].map((i) => rejected.decisions.get(i)?.rules_version)).toEqual([2, 2]);

    const legacy = beforeRelease(rejected.checkpoint);
    const reserve = input.rows.map((row, i) => ({ ...row, email: `info${i}@example.test`, _email_status: 'ok',
      _ve_relevance: legacy.verdicts[keyOf(legacy, [QUOTES.meat, QUOTES.smokehouse][i])] }));
    // Completed website and triage checks: before this release nothing selected these rows.
    expect(needsVeRelevanceEvidence(reserve[0])).toBe(false);
    expect(buildVeRelevanceReviewBatch({ reserve, ready: [], source: [], automatic: true, triage: true }).companies).toBe(2);

    const calls = provider(() => 'direct_match');
    const rechecked = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: legacy });
    expect([0, 1].map((i) => rechecked.decisions.get(i)?.status)).toEqual(['relevant', 'relevant']);
    // One DeepSeek batch and one gpt-5-mini confirmation for both; nothing else is bought.
    expect(calls).toMatchObject({ rubric: 0, classify: 0, jev: 0, deepseek: 1, confirm: 1, reviewed: 4 });
    expect(fetchEvidence).toHaveBeenCalledTimes(1);
    const review = calls.requests.find((request) => request.kind === 'review')!;
    expect(review.user).toContain(JSON.stringify(QUOTES.meat).slice(1, -1));
    expect(rechecked.decisions.get(0)).toMatchObject({ website_review_version: 4, triage_version: 1, review_attempts: 1,
      evidence: [{ field: 'description', quote: QUOTES.meat }] });
    const records = Object.values(rechecked.checkpoint.semantic_reviews);
    expect(records).toHaveLength(2);
    expect(records.map((item) => [item.status, item.rules])).toEqual([['finished', 2], ['finished', 2]]);

    const replay = provider();
    const again = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: rechecked.checkpoint });
    expect([0, 1].map((i) => again.decisions.get(i)?.status)).toEqual(['relevant', 'relevant']);
    expect(replay).toMatchObject({ rubric: 0, classify: 0, jev: 0, deepseek: 0, confirm: 0 });

    // DeepSeek applied the type rule unevenly between identical runs: its rejection in this last
    // automatic look is decided by gpt-5-mini, and an admission of gpt-5-mini stands.
    const secondOpinion = provider((model) => model === 'openai/gpt-5-mini' ? 'direct_match' : 'insufficient');
    const overruled = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: legacy });
    expect([0, 1].map((i) => overruled.decisions.get(i)?.status)).toEqual(['relevant', 'relevant']);
    expect(secondOpinion).toMatchObject({ classify: 0, jev: 0, deepseek: 1, confirm: 1, reviewed: 4 });
    expect(Object.values(overruled.checkpoint.semantic_reviews).map((item) => [item.status, item.rules, item.recheck, item.result?.result]))
      .toEqual([['finished', 2, true, 'direct_match'], ['finished', 2, true, 'direct_match']]);

    // A rejection both models repeat keeps the completed website and triage marks and is stamped:
    // it goes neither to the website pass nor back into the saved-review selection.
    const repeated = provider(() => 'insufficient');
    const still = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: legacy });
    expect(repeated).toMatchObject({ classify: 0, jev: 0, deepseek: 1, confirm: 1 });
    expect(fetchEvidence).toHaveBeenCalledTimes(1);
    expect(still.decisions.get(0)).toMatchObject({ status: 'needs_review', website_review_version: 4, triage_version: 1,
      rules_version: VE_RELEVANCE_RULES_VERSION });
    const stamped = input.rows.map((row, i) => ({ ...row, email: `info${i}@example.test`, _email_status: 'ok', _ve_relevance: still.decisions.get(i) }));
    expect(needsVeRelevanceEvidence(stamped[0])).toBe(false);
    for (const triage of [true, false]) {
      expect(buildVeRelevanceReviewBatch({ reserve: stamped, ready: [], source: [], automatic: true, triage }).companies).toBe(0);
    }
    const settled = provider();
    await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: still.checkpoint });
    expect(settled).toMatchObject({ classify: 0, deepseek: 0, confirm: 0, jev: 0 });

    // 13.10.2026, saved MetroFitness rejection: five club addresses were already
    // quoted, but the old reviewer demanded reception and a sales department.
    // The excerpt is contact-free; the provider below is a double, not a live
    // adjudication. This pins checkpoint recovery and its cost boundaries only.
    const fitness = {
      verticalName: 'Фитнес и спорт', hypothesisTitle: 'Фитнес-сети',
      hypothesisDescription: 'Фитнес-клубы от 5 филиалов: ресепшен и отдел продаж абонементов, продление, заморозки, персональные тренировки, работа с возражениями.',
      quote: 'Современные тренажерына все группы мышц\n\nКлубы МетроFitness в Екатеринбурге\n\nАмундсена, 63\nМашиностроителей, 22\nУральская, 61а\nКрауля 63\nХалтурина, 55',
      reason: 'MetroFitness: перечислены 5+ клубов в Екатеринбурге, явная сеть. Но нет упоминаний ресепшен и отдела продаж абонементов; только описание клубов и услуг.',
      result: 'direct_match' as const,
    };
    // An own laboratory really is stated in this target. Removing contextual
    // reception/sales conditions must not turn missing laboratory evidence into
    // an admission, or a saved direct conflict into a new paid review.
    const refinery = { verticalName: 'Промышленность', hypothesisTitle: 'Нефтеперерабатывающие заводы',
      hypothesisDescription: 'НПЗ с лабораториями контроля сырья, полуфабрикатов и готовых нефтепродуктов.',
      quote: 'Наш нефтеперерабатывающий завод перерабатывает нефть и выпускает бензин и дизельное топливо.',
      reason: 'Нефтепереработка подтверждена, но сведений о собственной лаборатории нет.',
      result: 'insufficient' as const };
    for (const scenario of [fitness, refinery]) {
      const { quote, reason, result: assessment, ...scope } = scenario;
      const row = { company: scenario === fitness ? 'MetroFitness' : 'НПЗ', description: quote,
        email: 'info@fixture.test', _email_status: 'ok' };
      const fixtureInput = { ...scope, rows: [row], language: 'ru' as const, triage: true };
      provider(() => 'insufficient');
      const site = offline();
      const saved = beforeRelease((await findIrrelevantRows({ ...fixtureInput, fetchEvidence: site })).checkpoint);
      const key = keyOf(saved, quote), ref = saved.semantic_review_refs[key];
      saved.semantic_reviews[ref].attempts = 1;
      saved.semantic_reviews[ref].result = { result: 'insufficient', reason };
      saved.verdicts[key] = { ...saved.verdicts[key], reason: 'Смысловое соответствие не подтверждено: ' + reason,
        website_review_version: 4, triage_version: 1 };
      const selected = buildVeRelevanceReviewBatch({ reserve: [{ ...row, _ve_relevance: saved.verdicts[key] }],
        ready: [], source: [], automatic: true, allowPaidSearch: false, triage: true });
      expect([scope.hypothesisTitle, selected.companies]).toEqual([scope.hypothesisTitle, 1]);
      site.mockClear();
      const recoveredCalls = provider(() => assessment);
      const recovered = await findIrrelevantRows({ ...fixtureInput, fetchEvidence: site, allowPaidSearch: false, checkpoint: saved });
      expect(recovered.decisions.get(0)?.status).toBe(assessment === 'direct_match' ? 'relevant' : 'needs_review');
      expect(recoveredCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 1, confirm: 1 });
      expect(site).not.toHaveBeenCalled();
      for (const request of recoveredCalls.requests) {
        expect(request.kind).toBe('review');
        expect(request.user).toContain(scope.hypothesisDescription);
        expect(request.user).toContain(JSON.stringify(quote).slice(1, -1));
        expect(request.system).toContain('Sector evidence alone cannot prove a required own laboratory or a network.');
      }
      const replayCalls = provider();
      const repeated = await findIrrelevantRows({ ...fixtureInput, fetchEvidence: site, allowPaidSearch: false, checkpoint: recovered.checkpoint });
      expect(repeated.decisions.get(0)?.status).toBe(recovered.decisions.get(0)?.status);
      expect(replayCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
      expect(buildVeRelevanceReviewBatch({ reserve: [{ ...row, _ve_relevance: repeated.decisions.get(0) }],
        ready: [], source: [], automatic: true, allowPaidSearch: false, triage: true }).companies).toBe(0);
      expect(site).not.toHaveBeenCalled();
      const conflict = structuredClone(saved);
      conflict.semantic_reviews[ref].result = { result: 'direct_conflict', reason: 'Доказано несовместимое направление деятельности.' };
      const conflictCalls = provider();
      const held = await findIrrelevantRows({ ...fixtureInput, fetchEvidence: site, allowPaidSearch: false, checkpoint: conflict });
      expect(held.decisions.get(0)?.status).toBe('needs_review');
      expect(conflictCalls).toMatchObject({ classify: 0, rubric: 0, jev: 0, deepseek: 0, confirm: 0 });
    }
  });

  it('rechecks a rejection of a proposal made on the read website text, and its quarantine', async () => {
    // The bulk of the production recheck (375 of 419 companies on 22.09.2026): the site was read,
    // the classifier proposed the company from the site text, and the review rejected the proposal
    // (or failed twice). Built through the gate itself, not by editing a checkpoint.
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Лидер', inn: '6143000003', description: QUOTES.leader }] };
    const site = { status: 'ok', text: QUOTES.leaderSite, url: 'https://leader.test/', reason: 'ok', pages: 1 };
    for (const outcome of ['rejected', 'quarantined'] as const) {
      const fetchEvidence = jest.fn().mockResolvedValue(site);
      // The website excerpt is the second one, after the description.
      provider(() => 'insufficient', { status: 'relevant', ids: [1] },
        outcome === 'quarantined' ? { malformed: (user) => user.includes(QUOTES.leaderSite) } : {});
      const legacy = beforeRelease((await findIrrelevantRows({ ...input, fetchEvidence })).checkpoint);
      const key = keyOf(legacy, QUOTES.leaderSite);
      expect([outcome, legacy.website_evidence[key]?.status, legacy.website_evidence[key]?.refined]).toEqual([outcome, 'ok', true]);
      expect([outcome, legacy.verdicts[key].status, legacy.verdicts[key].reason]).toEqual([outcome, 'needs_review', outcome === 'rejected'
        ? 'Смысловое соответствие не подтверждено: Проверено по цитатам'
        : 'Смысловую проверку не удалось завершить после повторной попытки; контакт сохранён в резерве.']);
      expect([outcome, legacy.semantic_reviews[legacy.semantic_review_refs[key]]]).toEqual([outcome, expect.objectContaining(outcome === 'rejected'
        ? { status: 'finished', result: { result: 'insufficient', reason: 'Проверено по цитатам' } }
        : { status: 'failed', attempts: 2, failure_code: 'invalid_response' })]);
      const calls = provider(() => 'direct_match');
      const out = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: legacy });
      expect([outcome, calls.classify, calls.deepseek, calls.confirm, fetchEvidence.mock.calls.length]).toEqual([outcome, 0, 1, 1, 1]);
      expect([outcome, out.decisions.get(0)]).toEqual([outcome, expect.objectContaining({ status: 'relevant', website_review_version: 4,
        evidence: [{ field: 'website_text', quote: QUOTES.leaderSite }] })]);
    }
  });

  it('lets the fast check read a repeated rejection it has not seen, as it would without the recheck', async () => {
    // Saved before the fast check was switched on: no triage mark. The recheck comes first; a
    // company it rejects again still gets the fast check in the same pass instead of a false mark.
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Паюта', description: QUOTES.smokehouse }] };
    provider(() => 'insufficient');
    const legacy = beforeRelease((await findIrrelevantRows({ ...input, triage: false })).checkpoint);
    const key = keyOf(legacy, QUOTES.smokehouse);
    expect(legacy.verdicts[key].triage_version).toBeUndefined();
    const calls = provider(() => 'insufficient');
    const out = await findIrrelevantRows({ ...input, triage: true, checkpoint: legacy });
    expect(calls).toMatchObject({ classify: 0, deepseek: 1, confirm: 1, rubric: 1, jev: 1 });
    expect(out.decisions.get(0)).toMatchObject({ status: 'needs_review', triage_version: 1, rules_version: VE_RELEVANCE_RULES_VERSION });
    const settled = provider();
    await findIrrelevantRows({ ...input, triage: true, checkpoint: out.checkpoint });
    expect(settled).toMatchObject({ classify: 0, deepseek: 0, confirm: 0, jev: 0 });
  });

  it('keeps the second opinion of a recheck that a provider refusal postponed', async () => {
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Паюта', description: QUOTES.smokehouse }] };
    provider(() => 'insufficient');
    const legacy = beforeRelease((await findIrrelevantRows(input)).checkpoint);
    provider(() => 'insufficient', undefined, { reviewStatus: 402 });
    const refused = await findIrrelevantRows({ ...input, checkpoint: legacy });
    expect(refused.error).toContain('Requesty 402');
    expect(Object.values(refused.checkpoint.semantic_reviews)).toEqual([expect.objectContaining({ status: 'failed', failure_code: 'billing', recheck: true })]);
    // After the balance is topped up the refused attempt is given back, and the recheck is still a recheck.
    const calls = provider((model) => model === 'openai/gpt-5-mini' ? 'direct_match' : 'insufficient');
    const resumed = await findIrrelevantRows({ ...input, checkpoint: refused.checkpoint });
    expect(calls).toMatchObject({ classify: 0, deepseek: 1, confirm: 1 });
    expect(resumed.decisions.get(0)?.status).toBe('relevant');
  });

  it('rechecks a quarantined confirmation once, but leaves a provider refusal to its own resume', async () => {
    const input = { ...HYPOTHESES.confectionery, language: 'ru' as const, rows: [{ company: 'ЛКК', description: QUOTES.confectionery }] };
    provider(() => 'insufficient');
    const saved = (await findIrrelevantRows(input)).checkpoint;
    const cases = [
      { failure: 'invalid_response', attempts: 2, calls: { deepseek: 1, confirm: 1 } },
      // A refused (unpaid) attempt is only given back by its own resume.
      { failure: 'billing', attempts: 2, calls: { deepseek: 0, confirm: 1 } },
      { failure: 'configuration', attempts: 2, calls: { deepseek: 0, confirm: 1 } },
      // One failed attempt keeps its budget: the resume pays only the confirmation left.
      { failure: 'invalid_response', attempts: 1, calls: { deepseek: 0, confirm: 1 } },
    ] as const;
    for (const { failure, attempts, calls: expected } of cases) {
      const legacy = beforeRelease(saved);
      const key = keyOf(legacy, QUOTES.confectionery);
      const record = Object.values(legacy.semantic_reviews)[0];
      Object.assign(record, { status: 'failed', attempts, failure_code: failure });
      delete record.result;
      legacy.verdicts[key] = { ...legacy.verdicts[key], status: 'needs_review', website_review_version: 4,
        reason: 'Смысловую проверку не удалось завершить после повторной попытки; контакт сохранён в резерве.' };
      const calls = provider(() => 'direct_match');
      const resumed = await findIrrelevantRows({ ...input, checkpoint: legacy });
      expect([failure, attempts, resumed.decisions.get(0)?.status]).toEqual([failure, attempts, 'relevant']);
      // The recheck starts over with DeepSeek.
      expect([failure, attempts, calls.deepseek, calls.confirm]).toEqual([failure, attempts, expected.deepseek, expected.confirm]);
      expect(Object.values(resumed.checkpoint.semantic_reviews)[0]).toMatchObject({ status: 'finished', rules: 2 });
    }
  });

  it('keeps the website mark of a quarantined company without a site when the recheck rejects it again', async () => {
    // Quarantine stamps website_review_version without reading any site. A repeated rejection must keep
    // it: otherwise the company with an INN goes back to the website pass with paid search.
    const input = { ...HYPOTHESES.confectionery, language: 'ru' as const,
      rows: [{ company: 'ЛКК', inn: '7100000001', description: QUOTES.confectionery }] };
    provider(() => 'insufficient');
    const legacy = beforeRelease((await findIrrelevantRows({ ...input, fetchEvidence: offline() })).checkpoint);
    const key = keyOf(legacy, QUOTES.confectionery);
    delete legacy.website_evidence[key];
    const record = Object.values(legacy.semantic_reviews)[0];
    Object.assign(record, { status: 'failed', attempts: 2, failure_code: 'invalid_response' });
    delete record.result;
    legacy.verdicts[key] = { ...legacy.verdicts[key], status: 'needs_review', website_review_version: 4, evidence: [],
      reason: 'Смысловую проверку не удалось завершить после повторной попытки; контакт сохранён в резерве.' };
    const calls = provider(() => 'insufficient');
    const fetchEvidence = offline();
    const still = await findIrrelevantRows({ ...input, websiteLimit: 0, fetchEvidence, checkpoint: legacy });
    expect(calls).toMatchObject({ classify: 0, deepseek: 1, confirm: 1 });
    expect(still.decisions.get(0)).toMatchObject({ status: 'needs_review', website_review_version: 4, rules_version: VE_RELEVANCE_RULES_VERSION });
    expect(still.checkpoint.website_evidence[key]).toBeUndefined();
    expect(needsVeRelevanceEvidence({ ...input.rows[0], email: 'info@lkk.test', _email_status: 'ok', _ve_relevance: still.decisions.get(0) })).toBe(false);
  });

  it('leaves confirmed admissions alone and waits for unfinished website work', async () => {
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Элита Юга', inn: '6143000001', description: QUOTES.meat }] };
    provider(() => 'direct_match');
    const admitted = await findIrrelevantRows({ ...input, fetchEvidence: offline() });
    expect(admitted.decisions.get(0)?.status).toBe('relevant');
    const none = provider();
    const kept = await findIrrelevantRows({ ...input, fetchEvidence: offline(), checkpoint: beforeRelease(admitted.checkpoint) });
    expect(kept.decisions.get(0)?.status).toBe('relevant');
    expect(none).toMatchObject({ classify: 0, deepseek: 0, confirm: 0 });

    provider(() => 'insufficient');
    const rejected = (await findIrrelevantRows({ ...input, fetchEvidence: offline() })).checkpoint;
    const key = keyOf(rejected, QUOTES.meat);
    const site = { reader_version: 1 as const, reader_revision: 4 as const, text: '', url: 'https://elita.test/',
      review_attempt: REVIEW_ATTEMPT, review_attempts: 1, refined: true };
    type Pending = { website: VeRelevanceCheckpoint['website_evidence'][string]; verdict: Partial<VeRelevanceDecision>;
      evidence: Record<string, unknown>; allowPaidSearch: boolean; websiteLimit?: number;
      repair?: VeRelevanceCheckpoint['citation_repairs'][string] };
    const unread = { ...site, status: 'unavailable' as const, reason: 'offline' };
    const pending: Record<string, Pending> = {
      // Paid search is off: nothing can move this company in this pass.
      deferred: { website: { ...site, status: 'unavailable' as const, reason: 'paid_search_deferred', search_deferred: true as const },
        verdict: { search_deferred: true as const, reason: 'Дополнительный поиск отложен: сначала проверяем компании с имеющимися данными.' },
        evidence: { status: 'unavailable', text: '', url: '', reason: 'paid_search_deferred', search_deferred: true }, allowPaidSearch: false },
      // A search refusal that will be repeated.
      provider: { website: { ...site, status: 'error' as const, reason: 'Serper billing: no credits', provider_error: { kind: 'billing' as const, message: 'Serper billing: no credits' }, provider_error_attempts: 1 },
        verdict: { reason: 'После предыдущего сбоя поиска требуется повторная проверка. Контакт сохранён в резерве.' },
        evidence: { status: 'error', text: '', url: '', reason: 'x', provider_error: { kind: 'billing', message: 'Serper billing: no credits' } }, allowPaidSearch: true },
      // A timed-out site that is read once more in this very pass.
      timeout: { website: { ...site, status: 'unavailable' as const, reason: 'website_evidence_timeout', read_error_attempts: 1 },
        verdict: { reason: 'Сайт не ответил вовремя. Подтвердить соответствие компании пока не удалось; контакт сохранён в резерве.' },
        evidence: { status: 'unavailable', text: '', url: 'https://elita.test/', reason: 'website_evidence_timeout', timeout: 'page' }, allowPaidSearch: true },
      // Read site text not yet classified (an interrupted pass); outside this pass's website cap.
      refinement: { website: { ...site, status: 'ok' as const, reason: 'ok', text: QUOTES.meat, refined: false }, verdict: {},
        evidence: { status: 'unavailable', text: '', url: '', reason: 'offline' }, allowPaidSearch: true, websiteLimit: 0 },
      // A citation repair refused by the provider, kept for one repeat after the balance is fixed.
      repairRefused: { website: unread, verdict: {}, evidence: { status: 'unavailable', text: '', url: '', reason: 'offline' }, allowPaidSearch: true,
        repair: { input_hash: 'a'.repeat(64), review_attempt: REVIEW_ATTEMPT, status: 'finished', failure_code: 'billing',
          retry_proposal: { status: 'relevant', reason: 'Производство по сайту' } } },
      // A citation repair reserved by this same review and never answered: this pass settles it.
      repairStarted: { website: unread, verdict: {}, evidence: { status: 'unavailable', text: '', url: '', reason: 'offline' }, allowPaidSearch: true,
        repair: { input_hash: 'b'.repeat(64), review_attempt: REVIEW_ATTEMPT, status: 'started' } },
    };
    for (const [name, state] of Object.entries(pending)) {
      const legacy = beforeRelease(rejected);
      legacy.website_evidence[key] = state.website;
      if (state.repair) legacy.citation_repairs[key] = state.repair;
      const verdict = { ...legacy.verdicts[key], ...state.verdict, evidence: [] };
      delete verdict.website_review_version;
      legacy.verdicts[key] = verdict;
      const calls = provider(() => 'direct_match');
      const fetchEvidence = jest.fn().mockResolvedValue(state.evidence);
      const waiting = await findIrrelevantRows({ ...input, allowPaidSearch: state.allowPaidSearch, websiteLimit: state.websiteLimit,
        fetchEvidence, checkpoint: legacy });
      expect([name, calls.deepseek, calls.confirm]).toEqual([name, 0, 0]);
      expect([name, waiting.decisions.get(0)?.status, waiting.decisions.get(0)?.rules_version])
        .toEqual([name, expect.stringMatching(/^(?:needs_review|error)$/), undefined]);
      if (name === 'timeout') {
        // The retry budget of the site is now spent: the next pass rechecks the quotes.
        expect(fetchEvidence).toHaveBeenCalledTimes(1);
        const next = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: waiting.checkpoint });
        expect(next.decisions.get(0)?.status).toBe('relevant');
        expect(calls).toMatchObject({ deepseek: 1, confirm: 1 });
        expect(fetchEvidence).toHaveBeenCalledTimes(1);
      }
    }

    // Spent search retries or an unverified site identity downgrade the company in this pass
    // anyway, and a repair reserved in another review is never settled (its newer website
    // proposal stays unknown): stamp it without paying for a review it cannot use.
    const blocked = {
      exhausted: { website: { ...site, status: 'error' as const, reason: 'Serper 503', provider_error: { kind: 'transient' as const, message: 'Serper 503' }, provider_error_attempts: 3 } },
      unverified: { website: { status: 'ok' as const, text: '', url: 'https://elita.test/', reason: 'legacy', review_attempt: REVIEW_ATTEMPT, review_attempts: 1, refined: true } },
      repairElsewhere: { website: unread, repair: { input_hash: 'b'.repeat(64), review_attempt: 'c'.repeat(64), status: 'started' as const } },
    };
    for (const [name, { website, ...rest }] of Object.entries(blocked)) {
      const legacy = beforeRelease(rejected);
      legacy.website_evidence[key] = website;
      if ('repair' in rest) legacy.citation_repairs[key] = rest.repair;
      const calls = provider(() => 'direct_match');
      const fetchEvidence = offline();
      const saves: VeRelevanceCheckpoint[] = [];
      const stamped = await findIrrelevantRows({ ...input, websiteLimit: 0, fetchEvidence, checkpoint: legacy,
        onCheckpoint: async (checkpoint) => { saves.push(structuredClone(checkpoint)); } });
      expect([name, calls.deepseek, calls.confirm, fetchEvidence.mock.calls.length]).toEqual([name, 0, 0, 0]);
      expect([name, stamped.decisions.get(0)?.status, stamped.decisions.get(0)?.rules_version]).toEqual([name, 'needs_review', 2]);
      // The stamp is saved, or the next pass selects the company again.
      expect([name, saves.at(-1)?.verdicts[key]?.rules_version]).toEqual([name, 2]);
      const row = { ...input.rows[0], email: 'info@elita.test', _email_status: 'ok', _ve_relevance: stamped.decisions.get(0) };
      expect([name, buildVeRelevanceReviewBatch({ reserve: [row], ready: [], source: [], automatic: true }).companies]).toEqual([name, 0]);
      const quiet = provider(() => 'direct_match');
      await findIrrelevantRows({ ...input, websiteLimit: 0, fetchEvidence, checkpoint: stamped.checkpoint });
      expect([name, quiet.deepseek, quiet.confirm, quiet.classify]).toEqual([name, 0, 0, 0]);
    }
  });

  it('settles a rejection behind an unanswered citation repair within a few passes', async () => {
    // Waiting for website work must end: otherwise the row is selected by every automatic batch
    // and «Продолжить подготовку» never goes away.
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Элита Юга', inn: '6143000001', description: QUOTES.meat }] };
    provider(() => 'insufficient');
    const rejected = (await findIrrelevantRows({ ...input, fetchEvidence: offline() })).checkpoint;
    const key = keyOf(rejected, QUOTES.meat);
    for (const reviewAttempt of [REVIEW_ATTEMPT, 'c'.repeat(64)]) {
      let checkpoint = beforeRelease(rejected);
      checkpoint.website_evidence[key] = { reader_version: 1, reader_revision: 4, text: '', url: 'https://elita.test/', status: 'unavailable',
        reason: 'offline', review_attempt: REVIEW_ATTEMPT, review_attempts: 1, refined: true };
      checkpoint.citation_repairs[key] = { input_hash: 'b'.repeat(64), review_attempt: reviewAttempt, status: 'started' };
      const verdict = { ...checkpoint.verdicts[key], evidence: [] };
      delete verdict.website_review_version;
      checkpoint.verdicts[key] = verdict;
      const paid = { deepseek: 0, confirm: 0, classify: 0 };
      let last: VeRelevanceDecision | undefined;
      for (let pass = 0; pass < 3 && last?.rules_version !== VE_RELEVANCE_RULES_VERSION; pass++) {
        const calls = provider(() => 'direct_match');
        const out = await findIrrelevantRows({ ...input, fetchEvidence: offline(), checkpoint });
        checkpoint = out.checkpoint; last = out.decisions.get(0);
        paid.deepseek += calls.deepseek; paid.confirm += calls.confirm; paid.classify += calls.classify;
      }
      const settled = last?.status === 'relevant' || last?.rules_version === VE_RELEVANCE_RULES_VERSION;
      expect([reviewAttempt === REVIEW_ATTEMPT, settled, paid.classify]).toEqual([reviewAttempt === REVIEW_ATTEMPT, true, 0]);
      expect(paid.deepseek).toBeLessThanOrEqual(1);
      const row = { ...input.rows[0], email: 'info@elita.test', _email_status: 'ok', _ve_relevance: last };
      expect([reviewAttempt === REVIEW_ATTEMPT, buildVeRelevanceReviewBatch({ reserve: [row], ready: [], source: [], automatic: true }).companies])
        .toEqual([reviewAttempt === REVIEW_ATTEMPT, 0]);
    }
  });

  it('keeps every paid verdict of a checkpoint saved before the release and rechecks only its rejections', async () => {
    // Written by the code before this release (455e2d50e) for the meat hypothesis, triage on:
    // «Элита Юга» rejected, then hidden behind «Сайт не дал подтверждения»; «Паюта» rejected;
    // «Допущенный» admitted without a site; «Север» admitted from its read site (reader revision 4);
    // «Лидер» proposed from its read site and rejected by the review (site status ok).
    // Its hashes pin the context and semantic review keys: a changed key would throw the paid
    // checkpoint away (classifier, Jev, sites and search again) or buy the admissions again.
    const saved = savedBeforeRelease as unknown as VeRelevanceCheckpoint;
    expect(saved.context_hash).toBe('3cc71ba794c261d7f56aa02d93fd1f46ad943dfd10d3e8be11d1432887e52c17');
    const rows = [
      { company: 'Элита Юга', inn: '6143000001', description: QUOTES.meat },
      { company: 'Паюта', description: QUOTES.smokehouse },
      { company: 'Допущенный', description: 'Мясокомбинат производит колбасы и сосиски на собственном заводе.' },
      { company: 'Север', inn: '6143000002' },
      { company: 'Лидер', inn: '6143000003', description: QUOTES.leader },
    ];
    const calls = provider(() => 'direct_match');
    const fetchEvidence = offline();
    const out = await findIrrelevantRows({ ...HYPOTHESES.meat, language: 'ru', triage: true, rows, fetchEvidence,
      checkpoint: structuredClone(saved) });
    expect(out.checkpoint.context_hash).toBe(saved.context_hash);
    expect(rows.map((_, i) => out.decisions.get(i)?.status)).toEqual(['relevant', 'relevant', 'relevant', 'relevant', 'relevant']);
    // One DeepSeek batch and one confirmation for the three rejections; nothing else is bought again.
    expect(calls).toMatchObject({ rubric: 0, classify: 0, jev: 0, deepseek: 1, confirm: 1, reviewed: 6 });
    expect(out.decisions.get(4)).toMatchObject({ website_review_version: 4, evidence: [{ field: 'website_text', quote: QUOTES.leaderSite }] });
    expect(fetchEvidence).not.toHaveBeenCalled();
    expect(out.checkpoint.website_evidence).toEqual(saved.website_evidence);
    for (const index of [2, 3]) {
      const key = Object.keys(saved.verdicts).find((item) => saved.verdicts[item].status === 'relevant'
        && out.decisions.get(index)?.evidence[0]?.quote === saved.verdicts[item].evidence[0].quote)!;
      const ref = saved.semantic_review_refs[key];
      expect(out.checkpoint.semantic_review_refs[key]).toBe(ref);
      expect(out.checkpoint.semantic_reviews[ref]).toEqual(saved.semantic_reviews[ref]);
      expect(out.checkpoint.verdicts[key]).toEqual(saved.verdicts[key]);
    }
  });

  it('keeps a paid checkpoint whose rules marks it cannot read', () => {
    // A later release (or a rollback) may write marks this code does not know: they are dropped, never the checkpoint.
    const saved = structuredClone(savedBeforeRelease) as unknown as VeRelevanceCheckpoint;
    const [verdictKey] = Object.keys(saved.verdicts), [reviewKey] = Object.keys(saved.semantic_reviews);
    (saved.verdicts[verdictKey] as unknown as Record<string, unknown>).rules_version = 'v3';
    (saved.semantic_reviews[reviewKey] as unknown as Record<string, unknown>).rules = 0;
    (saved.semantic_reviews[reviewKey] as unknown as Record<string, unknown>).recheck = 'yes';
    const read = readRelevanceCheckpoint(saved, saved.context_hash);
    expect(Object.keys(read.verdicts)).toEqual(Object.keys(saved.verdicts));
    expect(Object.keys(read.semantic_reviews)).toEqual(Object.keys(saved.semantic_reviews));
    expect(read.verdicts[verdictKey].rules_version).toBeUndefined();
    expect(read.semantic_reviews[reviewKey].rules).toBeUndefined();
    expect(read.semantic_reviews[reviewKey].recheck).toBeUndefined();
  });

  it('never reopens a final Jev reject, a rejected irrelevant proposal or a direct conflict', async () => {
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Паюта', description: QUOTES.smokehouse }] };
    provider(() => 'insufficient');
    const insufficient = beforeRelease((await findIrrelevantRows(input)).checkpoint);
    const key = keyOf(insufficient, QUOTES.smokehouse);

    // A final Jev reject written later by the saved-reserve pass; the ref still leads to the old review.
    const jevReject = structuredClone(insufficient);
    jevReject.verdicts[key] = { version: 2, status: 'irrelevant', reason: 'Быстрая проверка: перепродажа', evidence: [],
      context_hash: jevReject.verdicts[key].context_hash, review_attempts: 1, triage_version: 1,
      triage: { outcome: 'reject', activity: 0.05, final: true } };
    let calls = provider(() => 'direct_match');
    let out = await findIrrelevantRows({ ...input, checkpoint: jevReject });
    expect([out.decisions.get(0)?.status, calls.deepseek, calls.confirm]).toEqual(['irrelevant', 0, 0]);

    // A proposed rejection the review did not confirm stays uncertain; it is not turned into a reject.
    const irrelevantProposal = structuredClone(insufficient);
    const record = Object.values(irrelevantProposal.semantic_reviews)[0];
    record.proposal = { ...record.proposal, status: 'irrelevant', reason: 'Торговый дом' };
    calls = provider(() => 'direct_conflict');
    out = await findIrrelevantRows({ ...input, checkpoint: irrelevantProposal });
    expect([out.decisions.get(0)?.status, out.decisions.get(0)?.rules_version, calls.deepseek, calls.confirm])
      .toEqual(['needs_review', VE_RELEVANCE_RULES_VERSION, 0, 0]);

    // A direct conflict is an affirmative contradiction, not a missing detail.
    provider(() => 'direct_conflict');
    const conflict = beforeRelease((await findIrrelevantRows(input)).checkpoint);
    expect(Object.values(conflict.semantic_reviews)[0].result?.result).toBe('direct_conflict');
    calls = provider(() => 'direct_match');
    out = await findIrrelevantRows({ ...input, checkpoint: conflict });
    expect([out.decisions.get(0)?.status, out.decisions.get(0)?.rules_version, calls.deepseek, calls.confirm])
      .toEqual(['needs_review', VE_RELEVANCE_RULES_VERSION, 0, 0]);
  });

  it('does not override a classifier verdict made later on the read website text', async () => {
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Элита Юга', inn: '6143000001', description: QUOTES.meat }] };
    const fetchEvidence = jest.fn().mockResolvedValue({ status: 'ok', text: QUOTES.site, url: 'https://elita.test/', reason: 'ok', pages: 1 });
    provider(() => 'insufficient', { status: 'needs_review', ids: [] });
    const first = await findIrrelevantRows({ ...input, fetchEvidence });
    const legacy = beforeRelease(first.checkpoint);
    const key = keyOf(legacy, QUOTES.meat);
    // The ref still leads to the first-pass rejection, but the saved verdict is the newer one from the site.
    expect(legacy.verdicts[key]).toMatchObject({ status: 'needs_review', reason: 'По сайту видны признаки производства, но деталей мало.' });
    expect(legacy.website_evidence[key]).toMatchObject({ status: 'ok', refined: true });
    const calls = provider(() => 'direct_match');
    const out = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint: legacy });
    expect([calls.deepseek, calls.confirm, calls.classify]).toEqual([0, 0, 0]);
    expect(out.decisions.get(0)).toMatchObject({ status: 'needs_review', rules_version: VE_RELEVANCE_RULES_VERSION,
      reason: 'По сайту видны признаки производства, но деталей мало.' });
    expect(fetchEvidence).toHaveBeenCalledTimes(1);
  });

  it('stamps a rejection without usable saved quotes instead of paying for a review it cannot run', async () => {
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Паюта', description: QUOTES.smokehouse }] };
    provider(() => 'insufficient');
    const legacy = beforeRelease((await findIrrelevantRows(input)).checkpoint);
    const key = keyOf(legacy, QUOTES.smokehouse);
    const record = Object.values(legacy.semantic_reviews)[0];
    record.proposal = { ...record.proposal, evidence: [{ field: 'company', quote: 'Паюта' }] };
    const before = structuredClone(record);
    const calls = provider(() => 'direct_match');
    const out = await findIrrelevantRows({ ...input, checkpoint: legacy });
    expect([calls.deepseek, calls.confirm]).toEqual([0, 0]);
    expect(out.decisions.get(0)).toMatchObject({ status: 'needs_review', rules_version: VE_RELEVANCE_RULES_VERSION,
      reason: legacy.verdicts[key].reason });
    expect(Object.values(out.checkpoint.semantic_reviews)).toEqual([before]);

    // A real saved failure: the classifier rejected an auto-parts buyer using
    // nothing but its employer's careers shell. Withhold that rejection for
    // free; actual HR services and an affirmative different business still use
    // the usual gate, even alongside exactly the same navigation text.
    const navigation = 'URL: https://hr.autotrade.test/\nhr.autotrade.test Приглашаем в команду Автотрейд! '
      + 'СВЯЖИТЕСЬ С НАМИ ВСЕ ВАКАНСИИ ЗДЕСЬ отправить резюме CRM-форма появится здесь';
    for (const sample of [
      { text: navigation, proposal: 'irrelevant' as const, status: 'needs_review', review: 'direct_conflict' as Result },
      { text: navigation + ' Подбираем сотрудников для других компаний и сопровождаем найм.',
        proposal: 'relevant' as const, status: 'relevant', review: 'direct_match' as Result },
      { text: navigation + ' Производим и продаём стальные трубы для заводов.',
        proposal: 'irrelevant' as const, status: 'irrelevant', review: 'direct_conflict' as Result },
    ]) {
      resetVeTriageState();
      const run = { verticalName: 'HR', hypothesisTitle: 'Кадровые агентства', language: 'ru' as const,
        triage: true, allowPaidSearch: false, rows: [{ company: 'Автотрейд', website: 'https://hr.autotrade.test/' }] };
      const calls = provider(() => sample.review, { status: sample.proposal, ids: [0] });
      const fetchEvidence = jest.fn().mockResolvedValue({ status: 'ok', text: sample.text,
        url: run.rows[0].website, reason: 'ok', pages: 1 });
      const checked = await findIrrelevantRows({ ...run, fetchEvidence });
      expect(checked.decisions.get(0)?.status).toBe(sample.status);
      expect(calls.requests.filter((request) => request.kind === 'repair')).toHaveLength(0);
      if (sample.status === 'needs_review') {
        expect([calls.classify, calls.deepseek, calls.confirm]).toEqual([1, 0, 0]);
        const reserve = [{ ...run.rows[0], email: 'review@example.test', _email_status: 'ok',
          _ve_relevance: checked.decisions.get(0) }];
        expect(buildVeRelevanceReviewBatch({ reserve, ready: [], source: [], automatic: true,
          allowPaidSearch: false, triage: true }).companies).toBe(0);
      }
      const count = (global.fetch as jest.Mock).mock.calls.length;
      const repeated = await findIrrelevantRows({ ...run, fetchEvidence, checkpoint: checked.checkpoint });
      expect(repeated.decisions.get(0)?.status).toBe(sample.status);
      expect(global.fetch).toHaveBeenCalledTimes(count);
      expect(fetchEvidence).toHaveBeenCalledTimes(1);
      expect(fetchEvidence.mock.calls[0][1]).toMatchObject({ allowPaidSearch: false });
    }
  });

  it('does not reuse an older rejection saved under the new review key', async () => {
    // «Элита Юга» was reviewed before its site was read; after the read the same quotes map to a
    // new review key. An old rejection already stored there must not answer the recheck.
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows: [{ company: 'Элита Юга', inn: '6143000001', description: QUOTES.meat }] };
    provider(() => 'insufficient');
    const legacy = beforeRelease((await findIrrelevantRows({ ...input, fetchEvidence: offline() })).checkpoint);
    const key = keyOf(legacy, QUOTES.meat);
    const oldRef = legacy.semantic_review_refs[key];
    provider(() => 'insufficient');
    const moved = beforeRelease((await findIrrelevantRows({ ...input, fetchEvidence: offline(), checkpoint: structuredClone(legacy) })).checkpoint);
    const newRef = moved.semantic_review_refs[key];
    expect(newRef).not.toBe(oldRef);
    expect(moved.semantic_reviews[newRef]).toMatchObject({ status: 'finished', result: { result: 'insufficient' } });
    // Both old records, the ref back on the first one.
    moved.semantic_reviews[oldRef] = legacy.semantic_reviews[oldRef];
    moved.semantic_review_refs[key] = oldRef;
    moved.verdicts[key] = legacy.verdicts[key];
    const calls = provider(() => 'direct_match');
    const out = await findIrrelevantRows({ ...input, fetchEvidence: offline(), checkpoint: moved });
    expect(out.decisions.get(0)?.status).toBe('relevant');
    expect(calls).toMatchObject({ deepseek: 1, confirm: 1 });
    expect(Object.keys(out.checkpoint.semantic_reviews)).toEqual([newRef]);
  });

  it('asks the citation repair for a quote per structural condition', async () => {
    // The site pass cites a registry code only: the admission needs a repaired quote.
    const input = { ...HYPOTHESES.restaurants, language: 'ru' as const, rows: [{ company: 'Joy\'s Pizza', inn: '7700000001', category: '56.10' }] };
    const calls = provider(() => 'direct_match', { status: 'relevant', ids: [1] });
    const fetchEvidence = jest.fn().mockResolvedValue({ status: 'ok', text: QUOTES.restaurants, url: 'https://joys.test/', reason: 'ok', pages: 1 });
    const out = await findIrrelevantRows({ ...input, fetchEvidence });
    const repair = calls.requests.find((request) => request.kind === 'repair');
    expect(repair?.system).toContain('for a relevant decision, one showing the activity and company type, plus one for each structural condition the hypothesis states');
    expect(repair?.user).toContain(HYPOTHESES.restaurants.hypothesisDescription);
    expect(repair?.user).not.toContain(SUMMARY_ONLY.restaurants);
    const secondPass = calls.requests.find((request) => request.kind === 'classify' && request.system.includes('Independent second look'));
    expect(secondPass?.system).toContain('Select 1-3 supplied excerpt IDs for relevant/irrelevant; for relevant, cover the activity and the company type, plus one for each structural condition the hypothesis states');
    // The repair abstained: nothing is admitted without a verbatim activity quote.
    expect(out.decisions.get(0)?.status).toBe('needs_review');
  });

  it('rechecks at most 200 rejections per call and takes the rest on the next call', async () => {
    // Unlike the general rules pass, the staffing correction has a durable
    // total ceiling: another job cannot buy the next two hundred companies.
    const saasRows = Array.from({ length: 201 }, (_, i) => ({ company: 'SaaS ' + i,
      description: 'Продукт ' + i + ': разрабатываем собственную облачную CRM для российского бизнеса по подписке.' }));
    const saasInput = { verticalName: 'IT', hypothesisTitle: 'B2B SaaS с remote-командами',
      hypothesisDescription: 'SaaS-вендоры из СНГ, нанимающие разработчиков в 2+ странах.',
      hypothesisOrigin: 'generated' as const, language: 'ru' as const, rows: saasRows };
    provider(() => 'insufficient');
    const saasSaved = (await findIrrelevantRows(saasInput)).checkpoint;
    const reason = 'Нет данных про remote-команду в 2+ странах.';
    for (const [key, verdict] of Object.entries(saasSaved.verdicts)) {
      verdict.reason = 'Смысловое соответствие не подтверждено: ' + reason;
      saasSaved.semantic_reviews[saasSaved.semantic_review_refs[key]].result = { result: 'insufficient', reason };
    }
    const saasCalls = provider(() => 'insufficient');
    const saasCapped = await findIrrelevantRows({ ...saasInput, checkpoint: saasSaved });
    expect(saasCalls).toMatchObject({ classify: 0, reviewed: 400, deepseek: 25, confirm: 25 });
    expect(Object.values(saasCapped.checkpoint.semantic_reviews).filter((review) => review.staffing_correction_version === 1)).toHaveLength(200);
    expect([...saasCapped.decisions.values()].every((decision) => decision.status === 'needs_review' && decision.staffing_correction_version === 1)).toBe(true);
    const unchanged = provider();
    await findIrrelevantRows({ ...saasInput, checkpoint: saasCapped.checkpoint });
    expect(unchanged).toMatchObject({ classify: 0, reviewed: 0, deepseek: 0, confirm: 0 });

    const rows = Array.from({ length: 201 }, (_, i) => ({ company: 'Колбасный цех ' + i,
      description: 'Цех ' + i + ' выпускает варёные колбасы, сосиски и мясные полуфабрикаты.' }));
    const input = { ...HYPOTHESES.meat, language: 'ru' as const, rows };
    provider(() => 'insufficient');
    const first = await findIrrelevantRows(input);
    expect([...first.decisions.values()].every((decision) => decision.status === 'needs_review')).toBe(true);
    const log = jest.fn();
    const calls = provider(() => 'insufficient');
    const capped = await findIrrelevantRows({ ...input, log, checkpoint: beforeRelease(first.checkpoint) });
    // Every DeepSeek rejection of the recheck gets the gpt-5-mini answer, in the same batches of 8.
    expect(calls).toMatchObject({ classify: 0, reviewed: 400, deepseek: 25, confirm: 25 });
    const marks = [...capped.decisions.values()].map((decision) => decision.rules_version);
    expect(marks.filter((mark) => mark === 2)).toHaveLength(200);
    expect(marks.filter((mark) => mark === undefined)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ждут следующего прохода 1'));
    const rest = provider(() => 'insufficient');
    const done = await findIrrelevantRows({ ...input, checkpoint: capped.checkpoint });
    expect(rest).toMatchObject({ classify: 0, reviewed: 2, deepseek: 1, confirm: 1 });
    expect([...done.decisions.values()].every((decision) => decision.rules_version === 2)).toBe(true);
  });

  it('selects saved uncertainty once for the rules pass and offers Continue until it is stamped', () => {
    const decision = { version: 2, status: 'needs_review', evidence: [{ field: 'description', quote: QUOTES.meat }],
      reason: 'Смысловое соответствие не подтверждено: нет данных о «Меркурии» и прослеживаемости партий.',
      context_hash: 'a'.repeat(64), review_attempts: 1, website_review_version: 4, triage_version: 1 };
    const row = { company: 'Элита Юга', inn: '6143000001', email: 'info@elita.test', _email_status: 'ok', _ve_relevance: decision };
    const stamped = { ...row, _ve_relevance: { ...decision, rules_version: VE_RELEVANCE_RULES_VERSION } };
    const select = (reserve: Array<Record<string, unknown>>, options: { triage?: boolean; allowPaidSearch?: boolean } = {}) =>
      buildVeRelevanceReviewBatch({ reserve, ready: [], source: [], automatic: true, ...options }).companies;
    for (const triage of [true, false]) {
      expect(select([row], { triage })).toBe(1);
      expect(select([stamped], { triage })).toBe(0);
    }
    expect(select([{ ...row, _email_status: 'invalid' }])).toBe(0);
    // Without paid search a deferred search stays excluded, or the same pass would repeat.
    const deferred = { ...row, _ve_relevance: { ...decision, search_deferred: true } };
    expect(select([deferred], { allowPaidSearch: false })).toBe(0);
    expect(select([deferred], { allowPaidSearch: true })).toBe(1);

    const base = (reserve: Array<Record<string, unknown>>) => ({ source: 'auto', status: 'analyzed', hypothesis_id: 'h1', project_id: 'p1',
      collect_info: { collection_mode: 'preview', target_checkpoint: { completed_round: 1 },
        target_progress: { status: 'limited', ready_rows: 0, ready_target: 500, round: 1, max_rounds: 100, candidates_processed: 17, max_candidates: 17 },
        relevance_reserve: { version: 1, rows: reserve } } });
    expect(canResumePartialPreview(base([row]))).toBe(true);
    expect(canResumePartialPreview(base([stamped]))).toBe(false);
    const completed = base([row]);
    expect(canResumePartialPreview({ ...completed, collect_info: { ...completed.collect_info,
      relevance_review_progress: { signature: relevanceHash(veSavedReviewSignature([row], { triage: isVeRelevanceTriageEnabled('p1') })), passes: 1 } } })).toBe(false);
    const existingOnly = base([deferred]);
    expect(canResumePartialPreview({ ...existingOnly, collect_info: { ...existingOnly.collect_info,
      search_policy: { phase: 'existing' } } })).toBe(false);
    // A repeated click must not turn a completed unknown SMTP verdict into a
    // fresh validation request. An unprocessed address remains resumable.
    const unknown = base([{ ...stamped, _email_status: 'unknown' }]);
    expect(canResumePartialPreview(unknown)).toBe(true);
    expect(canResumePartialPreview({ ...unknown, collect_info: { ...unknown.collect_info,
      saved_email_recovery: { version: 1, attempt_id: 'automatic:base',
        checked: { [relevanceHash(row.email)]: 'unknown' } } } })).toBe(false);
  });
});
