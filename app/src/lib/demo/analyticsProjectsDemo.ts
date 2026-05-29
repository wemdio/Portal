import type { Project } from '@/types';

/**
 * Representative sample projects for reviewing /analytics/projects locally
 * without a backend (npm run dev:ui sets NEXT_PUBLIC_UI_DEMO=1). Dates are
 * relative to now so the urgency tiers (overdue / due-soon / renewal) always
 * populate regardless of when it's run. NEVER used in production — the page
 * only falls back to this when NEXT_PUBLIC_UI_DEMO === '1'.
 */
function dayOffset(days: number): string {
  const dt = new Date(Date.now() + days * 86_400_000);
  return dt.toISOString().slice(0, 10);
}

export function getDemoProjects(): Project[] {
  return [
    // ── overdue ───────────────────────────────────────────────────────────
    { id: 'demo-1', name: 'Дела PR', client: 'Дела PR', specialist: 'Дмитрий К.', manager: 'Эльвира', status: 'В работе', deadline: dayOffset(-9), contacts_done: '34', contacts_obligation: '80', kpi_plan: '15', kpi_fact: '6', budget: 'от 159 000 ₽', hypotheses: 'Повторная цепочка по отказникам\nДобавить кейс в первое письмо' },
    { id: 'demo-2', name: '4dev', client: '4dev (под NDA)', specialist: 'Анастасия', manager: 'Эльвира', status: 'Тестирование', deadline: dayOffset(-36), contacts_done: '12', contacts_obligation: '60', hypotheses: 'Сменить оффер на отраслевой' },
    { id: 'demo-3', name: 'АДК Транс', client: 'АДК Транс', specialist: 'Дмитрий К.', status: 'В работе', deadline: dayOffset(-13), contacts_done: '50', contacts_obligation: '90' },
    // ── due soon (<= 7 days) ──────────────────────────────────────────────
    { id: 'demo-4', name: 'Profitsol', client: 'Profitsol', specialist: 'Алексей Динисюк', manager: 'Эльвира', status: 'В работе', deadline: dayOffset(1), contacts_done: '70', contacts_obligation: '80', kpi_plan: '20', kpi_fact: '18' },
    { id: 'demo-5', name: 'INXY', client: 'INXY', specialist: 'Анастасия', status: 'Тестирование', deadline: dayOffset(3) },
    { id: 'demo-6', name: 'ITLS', client: 'ITLS', specialist: 'Оля', status: 'В работе', deadline: dayOffset(5), contacts_done: '20', contacts_obligation: '50' },
    // ── renewals (8–30 days) ──────────────────────────────────────────────
    { id: 'demo-7', name: 'Roistat', client: 'Roistat', specialist: 'Глеб', manager: 'Дмитрий К.', status: 'Тестирование', deadline: dayOffset(12) },
    { id: 'demo-8', name: 'Loya', client: 'Loya', specialist: 'Илиана', status: 'Тестирование', deadline: dayOffset(13) },
    { id: 'demo-9', name: 'НАФИ', client: 'НАФИ', specialist: 'Антон', status: 'Тестирование', deadline: dayOffset(15), contacts_done: '40', contacts_obligation: '100' },
    { id: 'demo-10', name: 'Staff Line', client: 'Staff Line', specialist: 'Эльвира', status: 'В работе', deadline: dayOffset(17) },
    { id: 'demo-11', name: 'Банк Еды Русь', client: 'Банк Еды Русь', specialist: 'Эльвира', manager: 'Дмитрий К.', status: 'Тестирование', deadline: dayOffset(21) },
    { id: 'demo-12', name: 'Умные Новации', client: 'Умные Новации', specialist: 'Алина', status: 'В работе', deadline: dayOffset(24) },
    // ── completed (counts toward total, excluded from attention) ──────────
    { id: 'demo-13', name: 'Каскад-Металл', client: 'Каскад-Металл', specialist: 'Оля', status: 'Завершен', deadline: dayOffset(-40) },
    { id: 'demo-14', name: 'Велар', client: 'Velarwh', specialist: 'Глеб', status: 'Завершен', deadline: dayOffset(-25) },
  ];
}
