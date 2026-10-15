/**
 * Динамический финплан: «если продадим столько-то проектов по такому чеку —
 * какой будет месяц».
 *
 * Расчёт чистый и синхронный, без базы: на вход переменные, которые крутит
 * CEO, и ставки из должностных инструкций; на выход оборот, траты по статьям
 * и маржа. Ставки вынесены в те же входы, а не зашиты константами — мотивации
 * меняются чаще кода (ставка специалиста сменилась в октябре 2026), и править
 * их должен человек на экране, а не разработчик.
 *
 * Что считается и откуда (должностные инструкции, октябрь 2026):
 * - специалист: фикс за каждый проект месяца (первичка и продление одинаково)
 *   плюс процент от суммы продлений; оклада нет, поэтому число специалистов
 *   влияет не на траты, а на загрузку (норма проектов на человека);
 * - лид: оклад плюс процент от продлений, процент зависит от тарифа — берём по
 *   среднему чеку продления;
 * - МОП («Новая мотивация ОП», 02.10.2026): оклад; 10% первички — только если
 *   личный план выполнен; 9% с продлений, которые МОП закрыл сам (тогда лид за
 *   них бонус не получает), — всегда, без привязки к плану;
 * - РОП (та же мотивация, версия 04.08.2026 — в октябрьской раздела нет): оклад
 *   плюс фикс-бонус за выполнение плана отдела, процента с продаж нет;
 * - CEO: оклад или доля чистой прибыли, что больше; доля растёт с 20 до 30%
 *   при обороте от 4 млн.
 */

export interface ForecastInputs {
  // Переменные — их крутят чаще всего.
  newProjects: number;
  newCheck: number;
  renewals: number;
  renewalCheck: number;
  specialists: number;
  leads: number;
  sellers: number;

  // Ставки и постоянные расходы.
  specialistPerProject: number;
  specialistRenewalPct: number;
  specialistNorm: number;
  leadSalary: number;
  sellerSalary: number;
  sellerNewPct: number;
  sellerPlan: number;
  sellerRenewalSharePct: number;
  sellerRenewalPct: number;
  ropSalary: number;
  departmentPlan: number;
  ceoSalary: number;
  ceoProfitPct: number;
  ceoProfitPctHigh: number;
  ceoHighTurnover: number;
  otherPayroll: number;
  otherCosts: number;
  taxPct: number;
  targetMarginPct: number;
  targetRenewalSharePct: number;
}

export const DEFAULT_INPUTS: ForecastInputs = {
  newProjects: 8,
  newCheck: 179_000,
  renewals: 3,
  renewalCheck: 179_000,
  specialists: 2,
  leads: 1,
  sellers: 2,

  specialistPerProject: 10_000,
  specialistRenewalPct: 12,
  specialistNorm: 7,
  leadSalary: 40_000,
  sellerSalary: 75_000,
  sellerNewPct: 10,
  sellerPlan: 1_200_000,
  sellerRenewalSharePct: 0,
  sellerRenewalPct: 9,
  ropSalary: 212_000,
  departmentPlan: 3_000_000,
  ceoSalary: 90_000,
  ceoProfitPct: 20,
  ceoProfitPctHigh: 30,
  ceoHighTurnover: 4_000_000,
  otherPayroll: 75_000,
  otherCosts: 0,
  taxPct: 6,
  targetMarginPct: 30,
  targetRenewalSharePct: 30,
};

/**
 * Процент лида от продления по тарифу (РФ-сетка): 84 000 → 9%, 179 000 → 15%,
 * 259 000 → 17%, 329 000 → 20%. Чек между ступенями получает нижнюю ступень.
 */
const LEAD_RENEWAL_STEPS: Array<{ from: number; pct: number }> = [
  { from: 329_000, pct: 20 },
  { from: 259_000, pct: 17 },
  { from: 179_000, pct: 15 },
  { from: 0, pct: 9 },
];

export function leadRenewalPct(renewalCheck: number): number {
  return LEAD_RENEWAL_STEPS.find((step) => renewalCheck >= step.from)?.pct ?? 9;
}

/**
 * Фикс-бонус РОПа по выполнению плана отдела (первичка + продления):
 * 90–109% → 50 000, 110–119% → 75 000, 120–129% → 100 000, 130%+ → 130 000.
 * В документе ступень «90–100%», а следующая начинается со 110% — промежуток
 * 100–109% отнесён к первой ступени, иначе перевыполнение обнуляло бы бонус.
 */
const ROP_BONUS_STEPS: Array<{ from: number; bonus: number }> = [
  { from: 1.3, bonus: 130_000 },
  { from: 1.2, bonus: 100_000 },
  { from: 1.1, bonus: 75_000 },
  { from: 0.9, bonus: 50_000 },
];

export function ropBonus(revenue: number, departmentPlan: number): number {
  if (departmentPlan <= 0) return 0;
  const done = revenue / departmentPlan;
  return ROP_BONUS_STEPS.find((step) => done >= step.from)?.bonus ?? 0;
}

export interface CostLine {
  key: string;
  label: string;
  amount: number;
  hint: string;
}

export interface ForecastResult {
  revenueNew: number;
  revenueRenewal: number;
  revenue: number;
  costs: CostLine[];
  totalCosts: number;
  profit: number;
  /** Доля прибыли в обороте. null — оборота нет. */
  margin: number | null;
  renewalShare: number | null;
  activeProjects: number;
  specialistsNeeded: number;
}

const pct = (value: number) => value / 100;
const nonNegative = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

export function computeForecast(raw: ForecastInputs): ForecastResult {
  const i = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, nonNegative(value)]),
  ) as unknown as ForecastInputs;

  const revenueNew = i.newProjects * i.newCheck;
  const revenueRenewal = i.renewals * i.renewalCheck;
  const revenue = revenueNew + revenueRenewal;
  const activeProjects = i.newProjects + i.renewals;
  const leadPct = leadRenewalPct(i.renewalCheck);
  const sellerRenewalShare = Math.min(pct(i.sellerRenewalSharePct), 1);
  // Бонус с первички — только при выполненном личном плане. Продажи делим на
  // МОПов поровну: прогноз не знает, кто сколько закроет.
  const sellerPlanDone = i.sellers > 0 && revenueNew / i.sellers >= i.sellerPlan;
  const ropBonusAmount = ropBonus(revenue, i.departmentPlan);

  const lines: CostLine[] = [
    {
      key: 'specialists',
      label: 'Специалисты',
      amount: activeProjects * i.specialistPerProject + pct(i.specialistRenewalPct) * revenueRenewal,
      hint: `${activeProjects} пр. × ставка + ${i.specialistRenewalPct}% продлений`,
    },
    {
      key: 'leads',
      label: 'Лиды',
      amount: i.leads * i.leadSalary + pct(leadPct) * revenueRenewal * (1 - sellerRenewalShare),
      hint: `оклад + ${leadPct}% продлений`,
    },
    {
      key: 'sellers',
      label: 'МОП',
      amount:
        i.sellers * i.sellerSalary +
        (sellerPlanDone ? pct(i.sellerNewPct) * revenueNew : 0) +
        pct(i.sellerRenewalPct) * revenueRenewal * sellerRenewalShare,
      hint: sellerPlanDone ? `оклад + ${i.sellerNewPct}% первички` : 'план не выполнен — только оклад',
    },
    {
      key: 'rop',
      label: 'РОП',
      amount: i.ropSalary + ropBonusAmount,
      hint: ropBonusAmount > 0 ? `оклад + бонус ${ropBonusAmount / 1000} тыс. за план` : 'оклад, план отдела < 90%',
    },
    { key: 'otherPayroll', label: 'Прочий ФОТ', amount: i.otherPayroll, hint: 'маркетолог, техспец' },
    { key: 'otherCosts', label: 'Прочие расходы', amount: i.otherCosts, hint: 'сервисы, почты, реклама' },
    { key: 'taxes', label: 'Налоги', amount: pct(i.taxPct) * revenue, hint: `${i.taxPct}% оборота` },
  ];

  const beforeCeo = revenue - lines.reduce((sum, line) => sum + line.amount, 0);
  const ceoPct = revenue >= i.ceoHighTurnover ? i.ceoProfitPctHigh : i.ceoProfitPct;
  // Оклад или доля прибыли — что больше. Прибыль до выплаты CEO: иначе доля
  // считалась бы от суммы, из которой её же и вычли.
  const ceoAmount = Math.max(i.ceoSalary, pct(ceoPct) * Math.max(beforeCeo, 0));
  lines.push({ key: 'ceo', label: 'CEO', amount: ceoAmount, hint: `оклад или ${ceoPct}% прибыли` });

  const totalCosts = lines.reduce((sum, line) => sum + line.amount, 0);
  const profit = revenue - totalCosts;

  return {
    revenueNew,
    revenueRenewal,
    revenue,
    costs: lines,
    totalCosts,
    profit,
    margin: revenue > 0 ? profit / revenue : null,
    renewalShare: revenue > 0 ? revenueRenewal / revenue : null,
    activeProjects,
    specialistsNeeded: i.specialistNorm > 0 ? Math.ceil(activeProjects / i.specialistNorm) : 0,
  };
}

/**
 * Подсказка «что крутить»: сколько нужно новых проектов при текущем чеке и
 * какой нужен чек первички при текущем числе проектов, чтобы выйти на целевую
 * маржу. null — при этих ставках цель недостижима в разумных пределах.
 */
export function marginLevers(inputs: ForecastInputs): {
  projectsNeeded: number | null;
  checkNeeded: number | null;
} {
  const target = pct(inputs.targetMarginPct);
  const reaches = (next: ForecastInputs) => {
    const { margin } = computeForecast(next);
    return margin !== null && margin >= target;
  };

  let projectsNeeded: number | null = null;
  if (inputs.newCheck > 0) {
    for (let n = Math.max(0, Math.floor(inputs.newProjects)); n <= 300; n += 1) {
      if (reaches({ ...inputs, newProjects: n })) {
        projectsNeeded = n;
        break;
      }
    }
  }

  let checkNeeded: number | null = null;
  if (inputs.newProjects > 0) {
    let low = 0;
    let high = 10_000_000;
    if (reaches({ ...inputs, newCheck: high })) {
      for (let step = 0; step < 40; step += 1) {
        const mid = (low + high) / 2;
        if (reaches({ ...inputs, newCheck: mid })) high = mid;
        else low = mid;
      }
      // Вверх до тысячи: чек — это тариф, а не точная сумма.
      checkNeeded = Math.ceil(high / 1000) * 1000;
    }
  }

  return { projectsNeeded, checkNeeded };
}
