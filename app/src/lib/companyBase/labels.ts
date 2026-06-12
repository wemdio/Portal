// EU/US company catalog (People Data Labs Free Company Dataset, CC BY 4.0):
// types, Russian labels for the English/lowercased enums, and the Tier-1
// synthesized description. Shared by the filter UI and the API.

export interface PdlCompanyRow {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  size: string | null;
  country: string | null;
  region: string | null;
  locality: string | null;
  founded: number | null;
  linkedin_url: string | null;
  description: string | null;
  description_source: string | null;
  description_fetched_at: string | null;
  created_at?: string;
}

export interface CompanyBaseFilters {
  industry?: string[];
  size?: string[];
  country?: string[];
  name?: string;
  limit?: number;
  offset?: number;
}

// PDL employee-count buckets, in order.
export const SIZE_BUCKETS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'] as const;

export function sizeLabelRu(size: string | null | undefined): string {
  if (!size) return '';
  return `${size} сотр.`;
}

// Country → RU label map. The dataset holds the whole world; this just gives
// nice Russian names to the common ones. Anything unmapped falls back to a
// title-cased version of the raw English value. The actual list of selectable
// countries comes from the live facets (all loaded countries), not from here.
export const COUNTRY_LABELS: { code: string; label: string }[] = [
  // EU / US / core English-speaking
  { code: 'united states', label: 'США' },
  { code: 'united kingdom', label: 'Великобритания' },
  { code: 'germany', label: 'Германия' },
  { code: 'france', label: 'Франция' },
  { code: 'netherlands', label: 'Нидерланды' },
  { code: 'spain', label: 'Испания' },
  { code: 'italy', label: 'Италия' },
  { code: 'ireland', label: 'Ирландия' },
  { code: 'sweden', label: 'Швеция' },
  { code: 'poland', label: 'Польша' },
  { code: 'belgium', label: 'Бельгия' },
  { code: 'switzerland', label: 'Швейцария' },
  { code: 'austria', label: 'Австрия' },
  { code: 'denmark', label: 'Дания' },
  { code: 'norway', label: 'Норвегия' },
  { code: 'finland', label: 'Финляндия' },
  { code: 'portugal', label: 'Португалия' },
  { code: 'canada', label: 'Канада' },
  { code: 'australia', label: 'Австралия' },
  { code: 'new zealand', label: 'Новая Зеландия' },
  // Rest of world (majors)
  { code: 'united arab emirates', label: 'ОАЭ' },
  { code: 'brazil', label: 'Бразилия' },
  { code: 'india', label: 'Индия' },
  { code: 'china', label: 'Китай' },
  { code: 'turkey', label: 'Турция' },
  { code: 'mexico', label: 'Мексика' },
  { code: 'south africa', label: 'ЮАР' },
  { code: 'argentina', label: 'Аргентина' },
  { code: 'japan', label: 'Япония' },
  { code: 'singapore', label: 'Сингапур' },
  { code: 'israel', label: 'Израиль' },
  { code: 'pakistan', label: 'Пакистан' },
  { code: 'nigeria', label: 'Нигерия' },
  { code: 'peru', label: 'Перу' },
  { code: 'malaysia', label: 'Малайзия' },
  { code: 'czechia', label: 'Чехия' },
  { code: 'czech republic', label: 'Чехия' },
  { code: 'egypt', label: 'Египет' },
  { code: 'philippines', label: 'Филиппины' },
  { code: 'romania', label: 'Румыния' },
  { code: 'bangladesh', label: 'Бангладеш' },
  { code: 'hungary', label: 'Венгрия' },
  { code: 'iran', label: 'Иран' },
  { code: 'indonesia', label: 'Индонезия' },
  { code: 'saudi arabia', label: 'Саудовская Аравия' },
  { code: 'colombia', label: 'Колумбия' },
  { code: 'chile', label: 'Чили' },
  { code: 'thailand', label: 'Таиланд' },
  { code: 'vietnam', label: 'Вьетнам' },
  { code: 'ukraine', label: 'Украина' },
  { code: 'greece', label: 'Греция' },
  { code: 'south korea', label: 'Южная Корея' },
  { code: 'hong kong', label: 'Гонконг' },
  { code: 'taiwan', label: 'Тайвань' },
  { code: 'russia', label: 'Россия' },
  { code: 'morocco', label: 'Марокко' },
  { code: 'kenya', label: 'Кения' },
  { code: 'ecuador', label: 'Эквадор' },
];

const COUNTRY_LABEL = new Map(COUNTRY_LABELS.map((c) => [c.code, c.label]));
export function countryLabelRu(code: string | null | undefined): string {
  if (!code) return '';
  return COUNTRY_LABEL.get(code) ?? code.replace(/\b\w/g, (m) => m.toUpperCase());
}

// Russian labels for the most common LinkedIn-industry enums; the long tail
// falls back to a title-cased version of the raw value.
const INDUSTRY_LABELS_RU: Record<string, string> = {
  'computer software': 'Программное обеспечение',
  'information technology and services': 'IT и сервисы',
  'internet': 'Интернет',
  'marketing and advertising': 'Маркетинг и реклама',
  'financial services': 'Финансовые услуги',
  'banking': 'Банки',
  'insurance': 'Страхование',
  'investment management': 'Управление инвестициями',
  'venture capital & private equity': 'Венчур и private equity',
  'accounting': 'Бухгалтерия',
  'management consulting': 'Управленческий консалтинг',
  'staffing and recruiting': 'Рекрутинг и стаффинг',
  'human resources': 'HR',
  'retail': 'Розница',
  'wholesale': 'Опт',
  'consumer goods': 'Потребительские товары',
  'apparel & fashion': 'Одежда и мода',
  'cosmetics': 'Косметика',
  'luxury goods & jewelry': 'Люкс и ювелирка',
  'food & beverages': 'Еда и напитки',
  'restaurants': 'Рестораны',
  'hospitality': 'Гостеприимство',
  'real estate': 'Недвижимость',
  'construction': 'Строительство',
  'architecture & planning': 'Архитектура и планирование',
  'automotive': 'Автомобили',
  'logistics and supply chain': 'Логистика и цепи поставок',
  'transportation/trucking/railroad': 'Транспорт и перевозки',
  'telecommunications': 'Телеком',
  'hospital & health care': 'Здравоохранение',
  'health, wellness and fitness': 'Здоровье и фитнес',
  'medical devices': 'Медицинское оборудование',
  'pharmaceuticals': 'Фармацевтика',
  'biotechnology': 'Биотехнологии',
  'education management': 'Образование',
  'e-learning': 'Онлайн-обучение',
  'higher education': 'Высшее образование',
  'legal services': 'Юридические услуги',
  'design': 'Дизайн',
  'graphic design': 'Графический дизайн',
  'media production': 'Медиапродакшн',
  'entertainment': 'Развлечения',
  'publishing': 'Издательское дело',
  'market research': 'Исследования рынка',
  'public relations and communications': 'PR и коммуникации',
  'events services': 'Организация мероприятий',
  'consumer electronics': 'Бытовая электроника',
  'semiconductors': 'Полупроводники',
  'computer hardware': 'Компьютерное железо',
  'computer & network security': 'Кибербезопасность',
  'computer networking': 'Сетевые технологии',
  'machinery': 'Машиностроение',
  'mechanical or industrial engineering': 'Промышленный инжиниринг',
  'electrical/electronic manufacturing': 'Электроника (производство)',
  'oil & energy': 'Нефть и энергетика',
  'renewables & environment': 'Возобновляемая энергетика',
  'environmental services': 'Экологические услуги',
  'farming': 'Сельское хозяйство',
  'nonprofit organization management': 'НКО',
  'government administration': 'Госуправление',
  'sports': 'Спорт',
  'furniture': 'Мебель',
};

export function industryLabelRu(value: string | null | undefined): string {
  if (!value) return '';
  return INDUSTRY_LABELS_RU[value] ?? value.replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Tier-1 description: synthesized from structured fields (instant, free, always
 * available). Real prose comes from the on-demand website scraper (Tier-2),
 * which overwrites `description`.
 */
export function synthDescription(row: Pick<PdlCompanyRow, 'industry' | 'country' | 'size'>): string {
  const parts = [industryLabelRu(row.industry), countryLabelRu(row.country)].filter(Boolean);
  const sized = row.size ? `${parts.join(', ')}, ${sizeLabelRu(row.size)}` : parts.join(', ');
  return sized;
}
