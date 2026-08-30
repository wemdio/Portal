import {
  deepestStage,
  groupByDeepestStage,
  FUNNEL_STAGE_ORDER,
  type FunnelHits,
} from '@/lib/firstSales/funnelDeals';

function hits(over: Partial<FunnelHits> = {}): FunnelHits {
  return { lead: false, qualified: false, meetings: 0, contract: false, ...over };
}

const allStages = { meetingsReliable: true, contractsReliable: true };

describe('deepestStage', () => {
  it('сделка с договором не считается лидом, хотя лидом тоже была', () => {
    // Воронка вложенная: те же договоры сидят и в лидах. Показывать сделку в
    // обеих группах — вывести одну карточку дважды.
    const stage = deepestStage(
      hits({ lead: true, qualified: true, meetings: 1, contract: true }),
      allStages,
    );
    expect(stage).toBe('contract');
  });

  it('встреча глубже квала, квал глубже лида', () => {
    expect(deepestStage(hits({ lead: true, qualified: true, meetings: 1 }), allStages)).toBe('meeting');
    expect(deepestStage(hits({ lead: true, qualified: true }), allStages)).toBe('qualified');
    expect(deepestStage(hits({ lead: true }), allStages)).toBe('lead');
  });

  it('встреча у сделки, пришедшей раньше периода, всё равно даёт ступень', () => {
    // Встречи считаются по дате самого события: сделка из июля со встречей в
    // августе в августовское число лидов не входит, но во «Встречах» стоять
    // обязана — иначе список молча теряет её.
    expect(deepestStage(hits({ meetings: 1 }), allStages)).toBe('meeting');
  });

  it('недостоверная ступень не назначается — сделка падает на ступень ниже', () => {
    const stage = deepestStage(
      hits({ lead: true, qualified: true, meetings: 1, contract: true }),
      { meetingsReliable: false, contractsReliable: false },
    );
    expect(stage).toBe('qualified');
  });

  it('без единой ступени воронки — null', () => {
    // Так выглядит сделка, попавшая в выборку только по оплате: оплата
    // ступенью воронки не является, и на самой воронке её тоже нет.
    expect(deepestStage(hits(), allStages)).toBeNull();
  });
});

describe('groupByDeepestStage', () => {
  const deals = [
    { id: 'a', h: hits({ lead: true }) },
    { id: 'b', h: hits({ lead: true, qualified: true }) },
    { id: 'c', h: hits({ lead: true, qualified: true, meetings: 2 }) },
    { id: 'd', h: hits({ lead: true, qualified: true, meetings: 1, contract: true }) },
    { id: 'e', h: hits() },
  ];

  it('порядок групп совпадает с воронкой: сверху лиды, снизу договоры', () => {
    const groups = groupByDeepestStage(deals, (d) => d.h, allStages);
    expect(groups.map((g) => g.stage)).toEqual(['lead', 'qualified', 'meeting', 'contract']);
  });

  it('каждая сделка ровно в одной группе', () => {
    const groups = groupByDeepestStage(deals, (d) => d.h, allStages);
    const ids = groups.flatMap((g) => g.deals.map((d) => d.id));
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd']); // 'e' не дала ни одной ступени
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('пустых групп не бывает', () => {
    const groups = groupByDeepestStage([deals[0]], (d) => d.h, allStages);
    expect(groups).toHaveLength(1);
    expect(groups[0].stage).toBe('lead');
  });

  it('недостоверные ступени групп не дают вовсе', () => {
    const groups = groupByDeepestStage(deals, (d) => d.h, {
      meetingsReliable: false,
      contractsReliable: false,
    });
    expect(groups.map((g) => g.stage)).toEqual(['lead', 'qualified']);
  });

  it('порядок сделок внутри группы сохраняется', () => {
    const same = [
      { id: 'first', h: hits({ lead: true }) },
      { id: 'second', h: hits({ lead: true }) },
    ];
    const groups = groupByDeepestStage(same, (d) => d.h, allStages);
    expect(groups[0].deals.map((d) => d.id)).toEqual(['first', 'second']);
  });

  it('порядок ступеней объявлен как на воронке, сверху вниз', () => {
    // Список стоит рядом с воронкой, и читать их в разные стороны нельзя.
    expect([...FUNNEL_STAGE_ORDER]).toEqual(['lead', 'qualified', 'meeting', 'contract']);
  });
});
