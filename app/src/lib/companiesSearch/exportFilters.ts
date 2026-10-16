import { z } from 'zod';
import { reduceToTopCodes } from './okved2';

const strings = z.array(z.string().trim().min(1).max(200)).max(10000).optional();
const number = z.number().finite().nonnegative().nullable().optional();

export const companyExportRequestSchema = z.object({
  regionCodes: strings,
  activityTypes: strings,
  okvedCodes: strings,
  hasPhone: z.boolean().optional(),
  hasEmail: z.boolean().optional(),
  legalForms: strings,
  hasWebsite: z.boolean().optional(),
  hasEdo: z.boolean().optional(),
  hasEgais: z.boolean().optional(),
  revenueFrom: number,
  revenueTo: number,
  costFrom: number,
  costTo: number,
  employeesFrom: number,
  employeesTo: number,
  includeIp: z.boolean().optional(),
  innList: strings,
  includeSeen: z.boolean().optional(),
  // Only an explicit request for a NEW export bypasses reuse by filters.
  exportRequestId: z.string().uuid().optional(),
});

export type CompanyExportFilters = Omit<z.infer<typeof companyExportRequestSchema>, 'exportRequestId'>;

/** Stable across array order and redundant descendants; shared with the UI. */
export function companyExportFilterKey(filters: CompanyExportFilters): string {
  const list = (values?: string[]) => [...new Set(values ?? [])].sort();
  return JSON.stringify({
    regionCodes: list(filters.regionCodes),
    activityTypes: list(filters.activityTypes),
    okvedCodes: reduceToTopCodes(new Set(filters.okvedCodes ?? [])).sort(),
    hasPhone: filters.hasPhone ?? false,
    hasEmail: filters.hasEmail ?? false,
    legalForms: list(filters.legalForms),
    hasWebsite: filters.hasWebsite ?? false,
    hasEdo: filters.hasEdo ?? false,
    hasEgais: filters.hasEgais ?? false,
    revenueFrom: filters.revenueFrom ?? null,
    revenueTo: filters.revenueTo ?? null,
    costFrom: filters.costFrom ?? null,
    costTo: filters.costTo ?? null,
    employeesFrom: filters.employeesFrom ?? null,
    employeesTo: filters.employeesTo ?? null,
    includeIp: filters.includeIp !== false,
    innList: list(filters.innList),
    includeSeen: filters.includeSeen ?? false,
  });
}
