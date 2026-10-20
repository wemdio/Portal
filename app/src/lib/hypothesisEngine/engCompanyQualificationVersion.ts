/** Shared with display-only client progress; keep this module free of server dependencies. */
export const HE_ENG_COMPANY_QUALIFICATION_VERSION = 3;
export type HeEngCompanyQualificationVersion = 2 | 3;

/** Reading a paid historical proof is separate from starting a current run. */
export function isHeEngCompanyQualificationVersion(value: unknown): value is HeEngCompanyQualificationVersion {
  return value === 2 || value === 3;
}
