import { UserProfile } from '@/types';
import { toIntlLocale, type Locale } from '@/lib/i18n';

type AssigneeProfile = Pick<UserProfile, 'email' | 'full_name'>;

export function getAssigneeDisplayName(profile: AssigneeProfile): string {
  const fullName = profile.full_name?.trim();
  if (fullName) return fullName;

  const email = profile.email?.trim();
  if (!email) return '';

  const localPart = email.split('@')[0]?.trim();
  return localPart || email;
}

export function buildAssigneeOptions(profiles: AssigneeProfile[], locale: Locale = 'ru'): string[] {
  const unique = new Set<string>();

  for (const profile of profiles) {
    const name = getAssigneeDisplayName(profile);
    if (name) unique.add(name);
  }

  return Array.from(unique).sort((a, b) => a.localeCompare(b, toIntlLocale(locale)));
}

/**
 * Maps stale display names (email local parts) to current full_name
 * for profiles where the user has since set a proper name.
 */
export function buildRenameMap(profiles: AssigneeProfile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const profile of profiles) {
    const fullName = profile.full_name?.trim();
    const email = profile.email?.trim();
    if (!fullName || !email) continue;
    const localPart = email.split('@')[0]?.trim();
    if (localPart && localPart !== fullName) {
      map.set(localPart, fullName);
    }
  }
  return map;
}

export function ensureCurrentAssigneeOption(
  options: string[],
  currentValue: string | null | undefined,
): string[] {
  const normalized = currentValue?.trim();
  if (!normalized) return options;
  if (options.includes(normalized)) return options;
  return [normalized, ...options];
}
