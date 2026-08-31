import { z } from 'zod';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { searchTwoGisCards } from '@/lib/twoGis/repository';
import type { BenchSearchPage, BenchSearchTool } from '../types';

/**
 * Общие справочники: 2GIS и «наша база баз».
 *
 * Оба помечены `access: 'shared-reference'` — они ходят в данные МИМО клиента
 * учётки-робота, и это осознанно. 2GIS вообще лежит в отдельной базе
 * (TWOGIS_DATASET_DB_URL) и читается прямым соединением; каталог компаний
 * читается служебным вызовом `companies_directory_fetch_rpc`.
 *
 * Разграничивать там нечего: у строк справочника нет владельца, все
 * внутренние пользователи видят одно и то же. Поэтому защита держится не на
 * правилах БД, а на двух других вещах — инструмента нет в списке ключа,
 * доступа нет вовсе; есть — объём ограничен суточной нормой строк.
 */

// -------------------------------------------------------------- 2GIS

const twoGisFilters = z
  .object({
    cities: z.array(z.string().min(1).max(200)).max(200).optional(),
    rubric_groups: z.array(z.string().min(1).max(200)).max(200).optional(),
    name: z.string().min(2).max(200).optional(),
    has_phone: z.boolean().optional(),
    has_email: z.boolean().optional(),
    has_website: z.boolean().optional(),
    has_vkontakte: z.boolean().optional(),
    has_instagram: z.boolean().optional(),
  })
  .strict();

type TwoGisParams = z.infer<typeof twoGisFilters>;

export const twoGisTool: BenchSearchTool = {
  id: '2gis',
  kind: 'search',
  title: '2GIS',
  access: 'shared-reference',
  filtersSchema: twoGisFilters,

  async run({ filters, limit, cursor }): Promise<BenchSearchPage> {
    const f = filters as TwoGisParams;
    // Репозиторий 2GIS уже умеет курсорную выдачу и сам зажимает limit в
    // свои пределы — не дублируем его правила, а пользуемся ими.
    const { rows, nextCursor } = await searchTwoGisCards(
      {
        cities: f.cities,
        rubricGroups: f.rubric_groups as never,
        name: f.name,
        hasPhone: f.has_phone,
        hasEmail: f.has_email,
        hasWebsite: f.has_website,
        hasVkontakte: f.has_vkontakte,
        hasInstagram: f.has_instagram,
      },
      { limit, cursor: cursor ?? undefined },
    );

    return { rows, cursor: nextCursor, has_more: Boolean(nextCursor) };
  },
};

// ------------------------------------------------------ Наша база баз

const ourBasesFilters = z
  .object({
    region_codes: z.array(z.string().min(1).max(20)).max(200).optional(),
    activity_types: z.array(z.string().min(1).max(200)).max(200).optional(),
    okved_codes: z.array(z.string().min(1).max(20)).max(200).optional(),
    legal_forms: z.array(z.string().min(1).max(50)).max(50).optional(),
    has_phone: z.boolean().optional(),
    has_email: z.boolean().optional(),
    has_website: z.boolean().optional(),
    has_edo: z.boolean().optional(),
    has_egais: z.boolean().optional(),
  })
  .strict();

type OurBasesParams = z.infer<typeof ourBasesFilters>;

export const ourBasesTool: BenchSearchTool = {
  id: 'our-bases',
  kind: 'search',
  title: 'Наша база баз',
  access: 'shared-reference',
  filtersSchema: ourBasesFilters,

  async run({ filters, limit, cursor }): Promise<BenchSearchPage> {
    const f = filters as OurBasesParams;
    // У RPC каталога постраничность по смещению, а не по курсору, — поэтому
    // здесь курсор это номер строки. Курсор остаётся строкой в контракте,
    // чтобы внешний код не разбирался, какой источник как листается.
    const offset = Math.max(0, Number(cursor) || 0);

    const { rows, error } = await searchRows(
      {
        regionCodes: f.region_codes,
        activityTypes: f.activity_types,
        okvedCodes: f.okved_codes,
        legalForms: f.legal_forms,
        hasPhone: f.has_phone,
        hasEmail: f.has_email,
        hasWebsite: f.has_website,
        hasEdo: f.has_edo,
        hasEgais: f.has_egais,
      },
      limit,
      offset,
    );
    // RPC возвращает ошибку значением, а не исключением: без этой проверки
    // сбой каталога выглядел бы снаружи как «ничего не нашлось».
    if (error) throw new Error(error);

    const hasMore = rows.length === limit;
    return {
      rows,
      cursor: hasMore ? String(offset + rows.length) : null,
      has_more: hasMore,
    };
  },
};
