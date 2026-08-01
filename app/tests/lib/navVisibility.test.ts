import {
  isNavEntryActive,
  isNavEntryVisible,
  isNavGroup,
  isNavItemActive,
  isNavTabVisible,
  navItems,
  navTree,
  visibleNavChildren,
  visibleNavEntries,
  type NavGroup,
  type NavVisibilityContext,
} from '@/lib/navigation';
import type { UserRole } from '@/types';

/**
 * Контекст видимости «как в UserProvider»: все nav-вкладки по умолчанию
 * выключены (точечная выдача через user_tool_visibility), инструменты
 * загружены и пустые.
 */
function ctx(overrides: Partial<NavVisibilityContext> = {}): NavVisibilityContext {
  return {
    userRole: null,
    navTabVisibility: { 'nav-tasks-board': false, 'nav-first-sales': false, 'nav-renewals': false },
    visibleTools: [],
    ...overrides,
  };
}

function role(userRole: UserRole, overrides: Partial<NavVisibilityContext> = {}): NavVisibilityContext {
  return ctx({ userRole, ...overrides });
}

const dashboards = navTree.find((entry) => entry.id === 'dashboards') as NavGroup;
const firstSales = navItems.find((item) => item.id === 'first-sales')!;
const renewals = navItems.find((item) => item.id === 'renewals')!;
const expenses = navItems.find((item) => item.id === 'expenses')!;

function findGroup(entries: ReturnType<typeof visibleNavEntries>): NavGroup | undefined {
  return entries.find((entry): entry is NavGroup => isNavGroup(entry) && entry.id === 'dashboards');
}

describe('nav tree shape', () => {
  it('«Дашборды» — группа с «Первичкой», «Продлениями» и «Расходами и доходами»', () => {
    expect(isNavGroup(dashboards)).toBe(true);
    expect(dashboards.children.map((child) => child.id)).toEqual(['first-sales', 'renewals', 'expenses']);
  });

  it('у группы нет собственного адреса — активность выводится из детей', () => {
    expect('href' in dashboards).toBe(false);
  });

  it('«Деньги» переименованы в «Расходы и доходы»', () => {
    expect(expenses.name).toBe('Расходы и доходы');
    expect(expenses.nameEn).toBe('Income & expenses');
    expect(expenses.href).toBe('/expenses');
  });

  it('правила доступа детей не изменились', () => {
    expect(expenses.adminOnly).toBe(true);
    expect(firstSales.navTabId).toBe('nav-first-sales');
    expect(firstSales.adminOnly).toBeUndefined();
  });

  it('«Продления» — точечная выдача по своему navTabId, как у «Первички»', () => {
    expect(renewals.navTabId).toBe('nav-renewals');
    expect(renewals.adminOnly).toBeUndefined();
    expect(renewals.href).toBe('/analytics/renewals');
  });

  it('navItems остаётся плоским списком конечных пунктов', () => {
    expect(navItems.some((item) => item.id === 'dashboards')).toBe(false);
    expect(navItems.map((item) => item.id)).toEqual(expect.arrayContaining(['first-sales', 'renewals', 'expenses']));
    expect(navItems.every((item) => typeof item.href === 'string' && item.href.length > 0)).toBe(true);
  });
});

describe('isNavTabVisible', () => {
  it('adminOnly — только админ', () => {
    expect(isNavTabVisible(expenses, role('admin'))).toBe(true);
    expect(isNavTabVisible(expenses, role('manager'))).toBe(false);
    expect(isNavTabVisible(expenses, role('director'))).toBe(false);
  });

  it('navTabId — точечная выдача, по умолчанию выключено', () => {
    expect(isNavTabVisible(firstSales, role('manager'))).toBe(false);
    expect(
      isNavTabVisible(firstSales, role('manager', { navTabVisibility: { 'nav-first-sales': true } })),
    ).toBe(true);
  });

  it('adminAlwaysOn — админ видит «Первичку» без строки в user_tool_visibility', () => {
    expect(isNavTabVisible(firstSales, role('admin'))).toBe(true);
  });

  it('adminAlwaysOn — админ видит «Продления» без строки в user_tool_visibility, менеджеру нужна выдача', () => {
    expect(isNavTabVisible(renewals, role('admin'))).toBe(true);
    expect(isNavTabVisible(renewals, role('manager'))).toBe(false);
    expect(
      isNavTabVisible(renewals, role('manager', { navTabVisibility: { 'nav-renewals': true } })),
    ).toBe(true);
  });

  it('requiresTool не фильтрует, пока список инструментов не загружен', () => {
    const instantly = navItems.find((item) => item.id === 'instantly')!;
    expect(isNavTabVisible(instantly, role('manager', { visibleTools: null }))).toBe(true);
    expect(isNavTabVisible(instantly, role('manager', { visibleTools: [] }))).toBe(false);
    expect(isNavTabVisible(instantly, role('manager', { visibleTools: ['instantly'] }))).toBe(true);
  });
});

describe('видимость группы «Дашборды»', () => {
  it('виден хотя бы один ребёнок — группа показывается', () => {
    const managerWithFirstSales = role('manager', {
      navTabVisibility: { 'nav-first-sales': true, 'nav-renewals': false },
    });
    expect(isNavEntryVisible(dashboards, managerWithFirstSales)).toBe(true);
    expect(findGroup(visibleNavEntries(managerWithFirstSales))).toBeDefined();
  });

  it('не виден ни один ребёнок — группы нет вовсе', () => {
    const plainManager = role('manager');
    expect(visibleNavChildren(dashboards, plainManager)).toEqual([]);
    expect(isNavEntryVisible(dashboards, plainManager)).toBe(false);
    expect(findGroup(visibleNavEntries(plainManager))).toBeUndefined();
  });

  it('админ видит всех троих детей', () => {
    const admin = role('admin');
    expect(visibleNavChildren(dashboards, admin).map((child) => child.id)).toEqual([
      'first-sales',
      'renewals',
      'expenses',
    ]);
    expect(findGroup(visibleNavEntries(admin))?.children).toHaveLength(3);
  });

  it('в списке только доступные пункты', () => {
    // Явно гасим nav-renewals: у менеджера выдана только «Первичка», и без
    // этой строки renewals попал бы в список — отсутствие ключа в
    // navTabVisibility трактуется как «не выключено» (см. NavVisibilityContext
    // в navigation.ts), а override здесь заменяет объект целиком, а не
    // домерживает его с дефолтом ctx().
    const managerWithFirstSales = role('manager', {
      navTabVisibility: { 'nav-first-sales': true, 'nav-renewals': false },
    });
    const group = findGroup(visibleNavEntries(managerWithFirstSales));
    expect(group?.children.map((child) => child.id)).toEqual(['first-sales']);
  });

  it('«Продления» в одиночку тоже раскрывают группу', () => {
    const managerWithRenewals = role('manager', {
      navTabVisibility: { 'nav-first-sales': false, 'nav-renewals': true },
    });
    const group = findGroup(visibleNavEntries(managerWithRenewals));
    expect(group?.children.map((child) => child.id)).toEqual(['renewals']);
  });

  it('«Расходы и доходы» в одиночку тоже раскрывают группу', () => {
    // Роли admin достаточно и для «Первички»/«Продлений» (adminAlwaysOn),
    // поэтому одиночный ребёнок проверяется на урезанной группе: только expenses.
    const onlyExpenses: NavGroup = { ...dashboards, children: [expenses] };
    expect(isNavEntryVisible(onlyExpenses, role('admin'))).toBe(true);
    expect(isNavEntryVisible(onlyExpenses, role('manager'))).toBe(false);
  });

  it('пруненая группа — копия, исходное дерево не мутируется', () => {
    visibleNavEntries(role('manager', { navTabVisibility: { 'nav-first-sales': true, 'nav-renewals': false } }));
    expect(dashboards.children).toHaveLength(3);
  });
});

describe('visibleNavEntries — остальное меню', () => {
  it('менеджер не видит админские и лидовые пункты', () => {
    const ids = visibleNavEntries(role('manager')).map((entry) => entry.id);
    expect(ids).toContain('projects');
    expect(ids).not.toContain('admin');
    expect(ids).not.toContain('mailbox-load');
    expect(ids).not.toContain('dashboards');
  });

  it('админ видит админские пункты и группу дашбордов', () => {
    const ids = visibleNavEntries(role('admin')).map((entry) => entry.id);
    expect(ids).toContain('admin');
    expect(ids).toContain('dashboards');
    expect(ids).toContain('invoices');
  });
});

describe('активность', () => {
  it('группа активна, когда открыт любой из детей', () => {
    expect(isNavEntryActive(dashboards, '/expenses')).toBe(true);
    expect(isNavEntryActive(dashboards, '/analytics/first-sales')).toBe(true);
    expect(isNavEntryActive(dashboards, '/analytics/first-sales/details')).toBe(true);
    expect(isNavEntryActive(dashboards, '/tasks')).toBe(false);
  });

  it('«Проекты» активны только на корне', () => {
    const projects = navItems.find((item) => item.id === 'projects')!;
    expect(isNavItemActive(projects, '/')).toBe(true);
    expect(isNavItemActive(projects, '/tasks')).toBe(false);
  });

  it('алиасы разделов учитываются', () => {
    const tools = navItems.find((item) => item.id === 'tools')!;
    expect(isNavItemActive(tools, '/parsers')).toBe(true);
    expect(isNavItemActive(tools, '/parsers/hh')).toBe(true);
    expect(isNavItemActive(tools, '/tools')).toBe(true);
  });
});
