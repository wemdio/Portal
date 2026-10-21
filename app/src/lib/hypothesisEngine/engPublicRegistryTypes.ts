/** Server-generated ENG discovery inputs. Registry records are never validated contacts. */
export type HeEngRegistryProvider = 'brreg' | 'france' | 'fdic' | 'nppes' | 'fmcsa' | 'companies_house';

export interface HeEngRegistryTask {
  id: string;
  provider: HeEngRegistryProvider;
  country: string;
  category: string;
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
}

export interface HeEngRegistryPage {
  candidates: HeEngRegistryCandidate[];
  nextPosition: number;
  exhausted: boolean;
  /** Counts rejected source records without retaining personal/contact values. */
  excluded: Record<string, number>;
  recordsRead: number;
}
