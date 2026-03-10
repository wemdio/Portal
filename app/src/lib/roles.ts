import { UserRole } from '@/types';
import { supabase } from './supabaseClient';

export const ROLE_LABELS: Record<UserRole, string> = {
  technician: 'Технарь',
  manager: 'Менеджер',
  director: 'Руководитель',
  admin: 'Админ',
  sales: 'Продажник',
  marketer: 'Маркетолог',
  lead: 'Лид',
};

export const ALL_ROLES: UserRole[] = ['technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead'];

const ROLES_CAN_CREATE_PROJECTS: UserRole[] = ['admin', 'manager', 'technician', 'director', 'lead'];
const ROLES_CAN_EDIT_PROJECTS: UserRole[] = ['admin', 'manager', 'technician', 'director', 'sales', 'marketer', 'lead'];
const ROLES_CAN_DELETE_PROJECTS: UserRole[] = ['admin', 'manager', 'director', 'lead'];
const ROLES_CAN_MANAGE_USERS: UserRole[] = ['admin'];
const ROLES_CAN_ACCESS_BILLING_CALENDAR: UserRole[] = ['technician', 'lead', 'admin', 'director'];

export function canCreateProjects(role: UserRole | null): boolean {
  if (!role) return false;
  return ROLES_CAN_CREATE_PROJECTS.includes(role);
}

export function canEditProjects(role: UserRole | null): boolean {
  if (!role) return false;
  return ROLES_CAN_EDIT_PROJECTS.includes(role);
}

export function canDeleteProjects(role: UserRole | null): boolean {
  if (!role) return false;
  return ROLES_CAN_DELETE_PROJECTS.includes(role);
}

export function canManageUsers(role: UserRole | null): boolean {
  if (!role) return false;
  return ROLES_CAN_MANAGE_USERS.includes(role);
}

export function isAdmin(role: UserRole | null): boolean {
  return role === 'admin';
}

export function canAccessBillingCalendar(role: UserRole | null): boolean {
  if (!role) return false;
  return ROLES_CAN_ACCESS_BILLING_CALENDAR.includes(role);
}

export function isTechnician(role: UserRole | null): boolean {
  return role === 'technician' || role === 'admin';
}

export function isLead(role: UserRole | null): boolean {
  return role === 'lead' || role === 'director' || role === 'admin';
}

export async function getUserRole(userId: string): Promise<UserRole | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (error || !data) return null;
  return data.role as UserRole | null;
}

export async function getCurrentUserRole(): Promise<UserRole | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user?.id) return null;
  return getUserRole(session.user.id);
}
