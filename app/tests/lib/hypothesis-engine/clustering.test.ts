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
  it('сливает синонимы в одну вертикаль, % суммируется с капом 100', () => {
    const hyps = [H('Банки', 40), H('Платёжные сервисы', 35), H('Необанки', 30), H('Стоматологии', 20)];
    const verticals = applyClusteringDecisions(hyps, [
      D('Финтех и платежи', ['Банки', 'Платёжные сервисы', 'Необанки'], ['банки', 'платёжки']),
    ]);
    expect(verticals).toHaveLength(2);
    expect(verticals[0].name).toBe('Финтех и платежи');
    expect(verticals[0].potential_pct).toBe(100); // 40+35+30=105 → кап
    expect(verticals[0].memberTitles).toEqual(['Банки', 'Платёжные сервисы', 'Необанки']);
    expect(verticals[0].rank).toBe(1);
    // Нераспределённая гипотеза — вертикаль-одиночка, ничего не теряется.
    expect(verticals[1].name).toBe('Стоматологии');
    expect(verticals[1].potential_pct).toBe(20);
    expect(verticals[1].rank).toBe(2);
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
    expect(verticals[0].potential_pct).toBe(65);
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

  it('пустые решения → все гипотезы становятся вертикалями-одиночками', () => {
    const hyps = [H('A', 10), H('B', 20)];
    const verticals = applyClusteringDecisions(hyps, []);
    expect(verticals).toHaveLength(2);
    expect(verticals.every((v) => v.memberTitles.length === 1)).toBe(true);
  });
});
