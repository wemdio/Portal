import { UserProfile } from '@/types';

type AssigneeProfile = Pick<UserProfile, 'email' | 'full_name'>;

export function getAssigneeDisplayName(profile: AssigneeProfile): string {
  const fullName = profile.full_name?.trim();
  if (fullName) return fullName;

  const email = profile.email?.trim();
  if (!email) return '';

  const localPart = email.split('@')[0]?.trim();
  return localPart || email;
}

export function buildAssigneeOptions(profiles: AssigneeProfile[]): string[] {
  const unique = new Set<string>();

  for (const profile of profiles) {
    const name = getAssigneeDisplayName(profile);
    if (name) unique.add(name);
  }

  return Array.from(unique).sort((a, b) => a.localeCompare(b, 'ru-RU'));
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
