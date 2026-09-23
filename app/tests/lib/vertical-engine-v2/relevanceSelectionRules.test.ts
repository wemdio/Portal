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
import { VE_RELEVANCE_RULES_VERSION } from '@/lib/verticalEngineV2/relevanceDecision';
import { buildVeRelevanceReviewBatch, needsVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceReserve';
import { canResumePartialPreview } from '@/lib/verticalEngineV2/collectionRecovery';
import { resetVeTriageState, veTriageRubricMessages } from '@/lib/verticalEngineV2/relevanceTriage';
import { VE_RELEVANCE_TARGET_RULES } from '@/lib/verticalEngineV2/relevanceReview';
import { readRelevanceCheckpoint, relevanceHash } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import type { VeRelevanceDecision } from '@/lib/verticalEngineV2/relevanceDecision';
import savedBeforeRelease from './fixtures/relevanceCheckpointBeforeRulesV2.json';

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
  secondPass: { status: 'relevant' | 'needs_review'; ids: number[] } = { status: 'relevant', ids: [0] },
  options: { reviewStatus?: number; malformed?: (user: string) => boolean } = {}) {
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
      return llm({ reviews: companies.map((item) => ({ i: item.i, result: review(body.model), reason: 'Проверено по цитатам' })) });
    }
    if (system.startsWith('Repair citations')) {
      calls.requests.push({ kind: 'repair', model: body.model, system, user });
      return llm({ evidence_ids: [] });
    }
    calls.classify += 1; calls.requests.push({ kind: 'classify', model: body.model, system, user });
    const batch = JSON.parse(user.split(/Rows, local indices [^\n]*:\n/)[1]) as Array<{ i: number; description: string }>;
    if (system.includes('Independent second look')) {
      return llm({ decisions: batch.map((item) => ({ i: item.i, status: secondPass.status,
        reason: secondPass.status === 'relevant' ? 'Производство по сайту' : 'По сайту видны признаки производства, но деталей мало.',
        evidence_ids: secondPass.ids })) });
    }
    return llm({ decisions: batch.map((item) => ({ i: item.i, status: 'relevant', reason: 'Собственное производство',
      evidence: [{ field: 'description', quote: item.description }] })) });
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
  });

  it('keeps the closed lists of structural conditions exact and free of size, in the rules and in the Jev checklist', () => {
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
  });
});
