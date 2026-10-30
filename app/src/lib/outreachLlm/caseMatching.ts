/** Подбор доказательства по бизнесу продавца, отдельно от его покупателей. */
export interface CaseMatchContext {
  business: string | null;
  customers?: string | null;
  key?: string;
}

export interface MatchableCase {
  id: string;
  groups: string[];
  text: string;
  profiles?: string[];
}

const PROFILES: Record<string, RegExp> = {
  software_development: /заказн.{0,25}разработ|разработк.{0,25}(?:по(?:\s|$)|программ|сайт)|custom software|software development|development (?:agency|team)|outsourc/i,
  workflow_software: /автоматизац.{0,35}(?:бизнес|процесс)|crm|bpmn|business process|workflow|service management|тоир|1с|1c|проверк.{0,20}контрагент|business verification/i,
  healthcare_ai: /(?:медицин|врач|клиник|medical|clinical|doctor|healthcare).{0,50}(?:ии|ai|ассистент)|(?:ии|ai).{0,50}(?:медицин|врач|medical|clinical|healthcare)/i,
  content_ai: /(?:генерац|generat).{0,35}(?:видео|video|контент|content)|(?:видео|video).{0,35}(?:генерац|generat)/i,
  ai_agents: /ии.?агент|ai agents?|ai automation/i,
  marketing_analytics: /сквозн.{0,15}аналитик|маркетингов.{0,20}(?:отч[её]т|аналитик)|marketing (?:analytics|reporting)|marketplace analytics/i,
  hr_recruitment: /рекрутингов.{0,20}агент|кадров.{0,15}агент|подбор.{0,25}(?:персонал|специалист)|recruitment (?:agency|services)|staffing/i,
  hr_software: /hr.?tech|hr.?платформ|hr automation|отпуск|vacation|leave management|кадров.{0,15}автоматизац|работ.{0,20}исполнител/i,
  employee_benefits: /бенефит|корпоративн.{0,20}(?:фитнес|льгот|благополуч)|поддержк.{0,15}сотрудник|employee benefits|corporate fitness|employee wellbeing/i,
  fintech_payments: /плат[её]ж|выплат|payroll|payments?|cross.border|эквайринг/i,
  reputation: /репутаци|reputation|отзыв|reviews? removal/i,
  marketing_services: /seo|маркетингов.{0,15}агент|digital.?агент|рекламн.{0,15}агент|marketing agency|digital agency|pr agency|брендинг|branding|дизайн.?студи/i,
  logistics_services: /грузоперевоз|перевозк|freight|cargo|transportation|фулфил|fulfil|fulfill/i,
  warehouse_equipment: /стеллаж|складск.{0,20}оборудован|warehouse (?:equipment|racking)/i,
  food_supply: /полуфабрикат|пищев.{0,15}сырь|замороженн.{0,20}продукт|морепродукт|рыб.{0,20}опт|frozen food|food (?:ingredients|wholesale)|seafood|съедобн.{0,15}стакан/i,
  lighting_supply: /осветительн|освещени|светодиод|lighting/i,
  furniture_interiors: /мебел|интерьер|furniture|interior/i,
  metal_manufacturing: /металло|металлическ|листов.{0,10}металл|metal fabrication|sheet metal|steel structures/i,
  construction_materials: /фасад|потолоч|строительн.{0,15}материал|facade|gfrc|ceiling/i,
  corporate_merch: /мерч|корпоративн.{0,15}подар|corporate (?:gifts|merch)|merchandise/i,
  education: /корпоративн.{0,15}обучен|аттестац|профессиональн.{0,15}обуч|corporate training|professional training|language schools/i,
  media_equipment: /видеолекц|запис.{0,15}видео|video recording equipment/i,
  pest_control: /пест.?контрол|дезинсекц|дератизац|pest control/i,
  industrial_equipment: /3d.?принтер|3d printers?|промышленн.{0,20}(?:оборудован|комплект)|industrial equipment|industrial components/i,
  beauty_equipment: /аппарат.{0,30}(?:коррекци|косметолог)|косметологическ.{0,20}оборудован|beauty equipment|body contouring/i,
  seasonal_decor: /новогодн.{0,15}(?:ел|ёл|оформлен)|хвойн.{0,15}композиц|christmas decor|christmas trees/i,
  event_software: /(?:платформ|platform|software).{0,35}(?:мероприяти|event management)|event management (?:software|saas)/i,
  fleet_software: /автопарк|fleet management|fleet maintenance|ремонт.{0,20}авто/i,
  legal_services: /патентн|интеллектуальн.{0,15}прав|юридическ.{0,20}услуг|patent (?:bureau|law)|b2b legal/i,
  ad_network: /рекламн.{0,15}сет|издател|ad network|publisher network/i,
  video_production: /видеопродакшн|видеопроизвод|video production/i,
  hvac_equipment: /климатическ.{0,15}оборудован|вентиляционн.{0,15}оборудован|hvac|climate equipment/i,
  corporate_finance: /корпоративн.{0,15}финанс|corporate finance|инвестиционн.{0,20}продукт/i,
};

function words(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? [])
    .filter((w) => !/^(?:компан|клиент|бизнес|лидов|лида|получ|помога|company|companies|leads|business|clients|help|with|from|that|their|your)/.test(w)));
}

export function rankCaseMatches<T extends MatchableCase>(
  cases: T[], group: string | null, context: CaseMatchContext, limit = 2,
): Array<{ record: T; reason: string }> {
  const business = context.business?.trim() ?? '';
  if (!business) return [];
  const profiles = Object.entries(PROFILES).filter(([, re]) => re.test(business)).map(([name]) => name);
  const terms = words([business, context.customers].filter(Boolean).join(' '));
  const ranked = cases.flatMap((c) => {
    const caseProfiles = c.profiles?.length ? c.profiles : Object.entries(PROFILES).filter(([, re]) => re.test(c.text)).map(([name]) => name);
    const common = profiles.filter((p) => caseProfiles.includes(p));
    if (group && !c.groups.includes(group) && !common.length) return [];
    // Совпадение покупателей или страны не исправляет несовпадение продукта.
    if (profiles.length && !common.length) return [];
    const overlap = [...words(c.text)].filter((w) => terms.has(w)).length;
    if (!common.length && overlap < 2) return [];
    let hash = 0;
    for (const char of `${context.key ?? ''}:${c.id}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const strength = common.reduce((sum, p) => sum + (['healthcare_ai', 'content_ai', 'reputation', 'warehouse_equipment'].includes(p) ? 160 : 100), 0);
    return [{ record: c, score: strength + (group && c.groups.includes(group) ? 15 : 0) + Math.min(overlap, 10) * 3, hash,
      reason: common.length ? `business match: ${common.join(', ')}` : 'product description overlap' }];
  });
  return ranked.sort((a, b) => b.score - a.score || a.hash - b.hash || a.record.id.localeCompare(b.record.id))
    .slice(0, limit).map(({ record, reason }) => ({ record, reason }));
}
