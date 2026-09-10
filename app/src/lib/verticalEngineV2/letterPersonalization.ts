import type { VeOperatorMapping } from './types';

const OPERATOR_RE = /\{\{\s*([A-Za-zА-Яа-яЁё0-9_.-]+)\s*\}\}/g;

/** Все уникальные операторы {{var}} в тексте, в порядке первого появления. */
export function extractPersonalizationOperators(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(OPERATOR_RE)) {
    const name = (m[1] ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[{}]/g, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactKey(s: string): string {
  return normalizeKey(s).replace(/\s+/g, '');
}

/**
 * Словарь синонимов: компактный ключ оператора → возможные названия колонок
 * (тоже нормализуются через normalizeKey). Покрывает канонические переменные
 * Instantly и типичные CSV-базы специалистов (ru/en наименования колонок).
 * Порядок внутри списка важен: первое точное совпадение побеждает.
 */
const OPERATOR_ALIASES: Record<string, string[]> = {
  firstname: ['имя', 'имя лида', 'first name', 'контакт имя'],
  lastname: ['фамилия', 'last name', 'surname'],
  fullname: ['фио', 'имя фамилия', 'full name', 'контакт'],
  name: ['имя', 'фио', 'контакт'],
  companyname: ['компания', 'название компании', 'company', 'company name', 'организация', 'бренд'],
  company: ['компания', 'название компании', 'company name', 'организация'],
  website: ['сайт', 'сайт компании', 'site', 'домен', 'url', 'website', 'веб сайт'],
  site: ['сайт', 'сайт компании', 'website', 'домен', 'url'],
  email: ['email', 'e mail', 'почта', 'эл почта', 'электронная почта', 'емейл'],
  phone: ['телефон', 'тел', 'phone', 'номер телефона'],
  position: ['должность', 'position', 'title', 'job title', 'роль', 'позиция'],
  jobtitle: ['должность', 'position', 'title', 'роль', 'позиция'],
  city: ['город', 'city', 'area', 'населенный пункт'],
  cityname: ['area', 'city', 'город', 'регион', 'населенный пункт', 'location'],
  region: ['регион', 'region', 'область'],
  country: ['страна', 'country'],
  vacancytitle: ['name', 'вакансия', 'должность', 'название вакансии', 'vacancy', 'position', 'позиция', 'job title'],
  vacancy: ['вакансия', 'название вакансии', 'vacancy', 'должность'],
  industry: ['отрасль', 'индустрия', 'industry', 'ниша'],
  segment: ['сегмент', 'segment'],
};

/**
 * Маппит операторы на колонки базы: точное совпадение (нормализованное),
 * затем таблица синонимов, затем подстрока. Маппинг возможен ТОЛЬКО на колонку
 * из переданного списка. Подстрочные правила ослаблены намеренно: короткие
 * кандидаты (<5 символов) и короткие имена колонок (<5) в подстроке не
 * участвуют — иначе cityName цеплялся бы к колонке «name» (вакансия), а не к
 * «area». Не нашлось — matched=false, column=null (специалист увидит дыру).
 */
export function mapOperatorsToColumns(operators: string[], columns: string[]): VeOperatorMapping[] {
  const normalizedColumns = columns.map((column) => ({ column, norm: normalizeKey(column) }));

  return operators.map((operator) => {
    const candidates = [normalizeKey(operator)];
    for (const alias of OPERATOR_ALIASES[compactKey(operator)] ?? []) {
      candidates.push(normalizeKey(alias));
    }

    for (const cand of candidates) {
      const exact = normalizedColumns.find((c) => c.norm === cand);
      if (exact) return { operator, column: exact.column, matched: true };
    }
    for (const cand of candidates) {
      if (cand.length < 5) continue;
      const partial = normalizedColumns.find((c) => c.norm.includes(cand));
      if (partial) return { operator, column: partial.column, matched: true };
    }
    for (const cand of candidates) {
      const partial = normalizedColumns.find((c) => c.norm.length >= 5 && cand.includes(c.norm));
      if (partial) return { operator, column: partial.column, matched: true };
    }
    return { operator, column: null, matched: false };
  });
}
