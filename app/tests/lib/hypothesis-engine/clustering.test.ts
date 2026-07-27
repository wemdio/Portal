/** @jest-environment node */

import { applyClusteringDecisions } from '@/lib/hypothesisEngine/stages/clustering';

const H = (title: string, potential_pct: number, description = '') => ({ title, potential_pct, description });

const D = (name: string, member_titles: string[], synonyms: string[] = [], summary = 's') => ({
  name,
  summary,
  synonyms,
  member_titles,
});

describe('applyClusteringDecisions', () => {
  it('сливает синонимы в одну вертикаль, % = max участников + 2 за каждого дополнительного', () => {
    const hyps = [H('Банки', 40), H('Платёжные сервисы', 35), H('Необанки', 30), H('Стоматологии', 20)];
    const verticals = applyClusteringDecisions(hyps, [
      D('Финтех и платежи', ['Банки', 'Платёжные сервисы', 'Необанки'], ['банки', 'платёжки']),
    ]);
    expect(verticals).toHaveLength(2);
    expect(verticals[0].name).toBe('Финтех и платежи');
    expect(verticals[0].potential_pct).toBe(44); // max 40 + 2×2 доп. участника
    expect(verticals[0].memberTitles).toEqual(['Банки', 'Платёжные сервисы', 'Необанки']);
    expect(verticals[0].rank).toBe(1);
    // Нераспределённая гипотеза — вертикаль-одиночка, ничего не теряется.
    expect(verticals[1].name).toBe('Стоматологии');
    expect(verticals[1].potential_pct).toBe(20);
    expect(verticals[1].rank).toBe(2);
  });

  it('вертикаль из одной гипотезы наследует её %', () => {
    const verticals = applyClusteringDecisions([H('Банки', 90)], []);
    expect(verticals).toHaveLength(1);
    expect(verticals[0].potential_pct).toBe(90);
  });

  it('кап 95: ни ширина, ни 100% гипотеза не выводят вертикаль на плато', () => {
    const hyps = [H('A', 94), H('B', 90), H('C', 88), H('D', 100)];
    const verticals = applyClusteringDecisions(hyps, [D('Широкая', ['A', 'B', 'C'])]);
    // 94 + 2×2 = 98 → кап 95.
    expect(verticals.find((v) => v.name === 'Широкая')!.potential_pct).toBe(95);
    // Даже одиночка со 100% уходит под кап — плато невозможно.
    expect(verticals.find((v) => v.name === 'D')!.potential_pct).toBe(95);
    // При равных 95 выигрывает вертикаль с большим числом участников.
    expect(verticals.map((v) => v.name)).toEqual(['Широкая', 'D']);
  });

  it('матчит member_titles регистронезависимо и игнорирует лишние пробелы', () => {
    const hyps = [H('Онлайн-школы английского', 50)];
    const verticals = applyClusteringDecisions(hyps, [D('EdTech', ['  онлайн-школы АНГЛИЙСКОГО '])]);
    expect(verticals).toHaveLength(1);
    expect(verticals[0].memberTitles).toEqual(['Онлайн-школы английского']);
    expect(verticals[0].potential_pct).toBe(50);
  });

  it('каждая гипотеза попадает максимум в одну вертикаль (выигрывает первая)', () => {
    const hyps = [H('Банки', 40), H('Страховые', 30)];
    const verticals = applyClusteringDecisions(hyps, [
      D('Финтех', ['Банки']),
      D('Финуслуги шире', ['Банки', 'Страховые']), // «Банки» уже заняты
    ]);
    const fintech = verticals.find((v) => v.name === 'Финтех')!;
    const wider = verticals.find((v) => v.name === 'Финуслуги шире')!;
    expect(fintech.memberTitles).toEqual(['Банки']);
    expect(wider.memberTitles).toEqual(['Страховые']);
  });

  it('два решения с одинаковым именем вертикали сливаются в одну', () => {
    const hyps = [H('Банки', 40), H('Необанки', 25)];
    const verticals = applyClusteringDecisions(hyps, [
      D('Финтех', ['Банки'], ['банк']),
      D(' финтех ', ['Необанки'], ['необанк']),
    ]);
    expect(verticals).toHaveLength(1);
    expect(verticals[0].memberTitles).toEqual(['Банки', 'Необанки']);
    expect(verticals[0].synonyms).toEqual(['банк', 'необанк']);
    expect(verticals[0].potential_pct).toBe(42); // max 40 + 2
  });

  it('решение без единого совпавшего title отбрасывается', () => {
    const hyps = [H('Банки', 40)];
    const verticals = applyClusteringDecisions(hyps, [D('Призрачная', ['Такой гипотезы нет'])]);
    expect(verticals).toHaveLength(1);
    expect(verticals[0].name).toBe('Банки'); // одиночка из нераспределённых
  });

  it('ранжирует вертикали по убыванию potential_pct', () => {
    const hyps = [H('A', 10), H('B', 90), H('C', 50)];
    const verticals = applyClusteringDecisions(hyps, []);
    expect(verticals.map((v) => v.name)).toEqual(['B', 'C', 'A']);
    expect(verticals.map((v) => v.rank)).toEqual([1, 2, 3]);
  });

  it('при равном % выше вертикаль с большим числом участников', () => {
    const hyps = [H('A', 40), H('B', 30), H('C', 42)];
    const verticals = applyClusteringDecisions(hyps, [D('Пара', ['A', 'B'])]);
    // «Пара»: 40 + 2 = 42; «C»-одиночка: 42 → равенство, выигрывает «Пара» (2 участника).
    expect(verticals.map((v) => v.name)).toEqual(['Пара', 'C']);
    expect(verticals.map((v) => v.rank)).toEqual([1, 2]);
  });

  it('при равном % и равном числе участников выигрывает вертикаль с более низким тиром', () => {
    const hyps = [
      { title: 'Экзотика', potential_pct: 50, tier: 3 },
      { title: 'Очевидные', potential_pct: 50, tier: 1 },
    ];
    const verticals = applyClusteringDecisions(hyps, []);
    expect(verticals.map((v) => v.name)).toEqual(['Очевидные', 'Экзотика']);
    expect(verticals.map((v) => v.rank)).toEqual([1, 2]);
  });

  it('тир учитывается по лучшему участнику вертикали', () => {
    const hyps = [
      { title: 'A1', potential_pct: 50, tier: 2 },
      { title: 'A2', potential_pct: 30, tier: 1 },
      { title: 'B1', potential_pct: 50, tier: 2 },
      { title: 'B2', potential_pct: 30, tier: 3 },
    ];
    const verticals = applyClusteringDecisions(hyps, [
      D('Вертикаль A', ['A1', 'A2']),
      D('Вертикаль B', ['B1', 'B2']),
    ]);
    // Обе: 50 + 2 = 52, по 2 участника → решает min тир (1 против 3).
    expect(verticals.map((v) => v.name)).toEqual(['Вертикаль A', 'Вертикаль B']);
  });

  it('полное равенство (% , участники, тир) — стабильный порядок по имени', () => {
    const hyps = [H('B', 50), H('A', 50)];
    const verticals = applyClusteringDecisions(hyps, []);
    expect(verticals.map((v) => v.name)).toEqual(['A', 'B']);
  });

  it('пустые решения → все гипотезы становятся вертикалями-одиночками', () => {
    const hyps = [H('A', 10), H('B', 20)];
    const verticals = applyClusteringDecisions(hyps, []);
    expect(verticals).toHaveLength(2);
    expect(verticals.every((v) => v.memberTitles.length === 1)).toBe(true);
  });
});
