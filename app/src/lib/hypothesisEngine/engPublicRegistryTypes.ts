/** Server-generated ENG discovery inputs. Registry records are never validated contacts. */
export type HeEngRegistryProvider = 'brreg' | 'france' | 'fdic' | 'nppes' | 'fmcsa' | 'companies_house' | 'gleif' | 'osm' | 'pra' | 'esma' | 'eba';

export interface HeEngRegistryTask {
  id: string;
  provider: HeEngRegistryProvider;
  country: string;
  category: string;
  /** New Companies House plans use the monthly snapshot; absence preserves API plans. */
  transport?: 'csv';
  /**
   * Global sources (GLEIF, OpenStreetMap) read every allowed country in one
   * slice, so a project with ten countries does not get ten slices per sector
   * ahead of its catalogue. `country` is then 'global'.
   */
  countries?: string[];
  minEmployees?: number;
  maxEmployees?: number;
}

export interface HeEngRegistryPlan {
  version: 1;
  scopeKey: string;
  fingerprint: string;
  tasks: HeEngRegistryTask[];
}

export interface HeEngRegistryCandidate {
  provider: HeEngRegistryProvider;
  recordId: string;
  company: string;
  country: string;
  address: string;
  /** Distinguish a business/practice address from registration-only evidence. */
  addressKind: 'business' | 'registered';
  category: string;
  employees?: string;
  employeeYear?: number;
  /** GLEIF: the entity's number in its local register («HRB 7876»), checked on its own site. */
  localRegistryId?: string;
  /** EBA: the supervisor's own reference («F0038» at DNB, «C58301» at the Central Bank of Ireland), checked on its own site. */
  supervisorReference?: string;
  website: string;
  emails: string[];
  description: string;
  sourceUrl: string;
}

export interface HeEngRegistryCursor {
  position: number;
  pages: number;
  exhausted: boolean;
  unavailable?: string;
  /** Bounded free-read retries for the current position; never a paid-call retry. */
  readFailures?: number;
  retryAt?: number;
}

export interface HeEngRegistryPage {
  candidates: HeEngRegistryCandidate[];
  nextPosition: number;
  exhausted: boolean;
  /** Counts rejected source records without retaining personal/contact values. */
  excluded: Record<string, number>;
  recordsRead: number;
}
