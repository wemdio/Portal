/**
 * Лицензии компаний «базы баз» по единому реестру МСП ФНС.
 *
 * В реестре МСП у каждой лицензии есть вид деятельности (СвЛиценз/НаимЛицВД)
 * и орган, который её выдал. Это точнее ОКВЭД: код 86 стоит у любой компании,
 * а лицензия на медицинскую деятельность — только у клиники. Группы ниже —
 * единый словарь для загрузки (scripts/fns-sme-licences.ts), таблицы
 * companies_directory_licences и фильтра licenceGroups в сборе VE2.
 *
 * Код группы хранится в базе: переименовывать нельзя, только добавлять.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const LICENCE_GROUPS = [
  { code: 'medical', label: 'медицинская деятельность: клиники, медцентры, стоматологии, лаборатории', pattern: /медицинская деятельность|медико-санитарн|медицинской помощи/i },
  { code: 'pharma', label: 'фармацевтическая деятельность: аптеки и аптечные сети, фармдистрибуторы (опт и розница лекарств для людей)', pattern: /фармацевтическ|(розничная|оптовая) торговля лекарственными средствами/i, exclude: /ветеринарн/i },
  { code: 'pharma_manufacturing', label: 'производство лекарственных средств: фармзаводы', pattern: /производство лекарственных|производство, хранение и реализация нестерильных лекарственных/i, exclude: /ветеринарн/i },
  { code: 'education', label: 'образовательная деятельность: частные школы и сады, ДПО, учебные центры, автошколы', pattern: /образовательн/i },
  { code: 'alcohol_retail', label: 'розничная продажа алкоголя: магазины, рестораны, бары', pattern: /розничная продажа алкогольн/i },
  { code: 'fire_safety', label: 'монтаж и обслуживание средств пожарной безопасности', pattern: /пожарной безопасности/i },
  { code: 'hazardous_objects', label: 'эксплуатация опасных производственных объектов: производства, котельные, АЗС', pattern: /опасных производственных объектов/i },
  { code: 'bus_transport', label: 'перевозка пассажиров автобусами', pattern: /перевозкам пассажиров и иных лиц автобусами/i },
  { code: 'housing_management', label: 'управление многоквартирными домами: управляющие компании', pattern: /многоквартирными домами/i },
  { code: 'waste', label: 'обращение с отходами I–IV класса опасности', pattern: /отходов i/i },
  { code: 'subsoil', label: 'пользование недрами: геологоразведка, добыча, скважины', pattern: /пользование недрами|пользование участками недр|геологическое изучение недр/i },
  { code: 'scrap_metal', label: 'заготовка и переработка лома металлов', pattern: /лома (черных|цветных)/i },
  { code: 'radiation_sources', label: 'источники ионизирующего излучения: рентген-кабинеты, медтехника', pattern: /ионизирующего излучения/i },
  { code: 'crypto', label: 'шифровальные средства и защита информации', pattern: /шифровальн/i },
  { code: 'security', label: 'частная охранная деятельность', pattern: /частная\)? охранная деятельность/i },
  { code: 'cultural_heritage', label: 'работы на объектах культурного наследия', pattern: /культурного наследия/i },
  { code: 'vet_drugs', label: 'оборот ветеринарных препаратов: ветаптеки, дистрибуторы', pattern: /ветеринарного применения/i },
] as const;

export type LicenceGroupCode = (typeof LICENCE_GROUPS)[number]['code'];

export const LICENCE_GROUP_CODES = LICENCE_GROUPS.map((group) => group.code) as unknown as readonly [LicenceGroupCode, ...LicenceGroupCode[]];

/** Группы по видам лицензируемой деятельности; порядок — как в LICENCE_GROUPS.
 * Каждый вид проверяется отдельно: «фармацевтическая деятельность … для
 * ветеринарного применения» — это ветпрепараты, а не аптека для людей. */
export function classifyLicenceActivities(activities: readonly string[]): LicenceGroupCode[] {
  const texts = activities.map((activity) => activity.replace(/ё/gi, 'е'));
  return LICENCE_GROUPS.filter((group) => texts.some((text) => group.pattern.test(text)
    && !('exclude' in group && group.exclude.test(text)))).map((group) => group.code);
}

/** Снимок старше этого срока считаем неактуальным: реестр МСП выходит каждый месяц. */
const LICENCE_SNAPSHOT_MAX_AGE_MS = 120 * 24 * 60 * 60 * 1000;

/**
 * Загружен ли свежий снимок лицензий. Пока таблицы нет (миграция не дошла) или
 * она пуста, фильтр licenceGroups ничего бы не находил, поэтому план сбора его
 * не предлагает. Ошибка чтения — тоже «нет»: план идёт по ОКВЭД, как раньше.
 */
export async function licenceSnapshotReady(db: SupabaseClient, now = Date.now()): Promise<boolean> {
  try {
    const { data, error } = await db.from('companies_directory_licences').select('snapshot_date')
      .order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
    if (error || !data?.snapshot_date) return false;
    const age = now - Date.parse(String(data.snapshot_date));
    return Number.isFinite(age) && age <= LICENCE_SNAPSHOT_MAX_AGE_MS;
  } catch {
    return false;
  }
}
