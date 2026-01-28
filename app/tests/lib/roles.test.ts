import { 
  ROLE_LABELS, 
  ALL_ROLES, 
  canCreateProjects, 
  canEditProjects, 
  canDeleteProjects, 
  canManageUsers, 
  isAdmin 
} from '@/lib/roles';
import { UserRole } from '@/types';

describe('Roles utilities', () => {
  describe('ROLE_LABELS', () => {
    it('should have labels for all roles', () => {
      ALL_ROLES.forEach(role => {
        expect(ROLE_LABELS[role]).toBeDefined();
        expect(typeof ROLE_LABELS[role]).toBe('string');
      });
    });

    it('should have correct labels', () => {
      expect(ROLE_LABELS.admin).toBe('Админ');
      expect(ROLE_LABELS.manager).toBe('Менеджер');
      expect(ROLE_LABELS.technician).toBe('Технарь');
      expect(ROLE_LABELS.director).toBe('Руководитель');
      expect(ROLE_LABELS.sales).toBe('Продажник');
      expect(ROLE_LABELS.marketer).toBe('Маркетолог');
    });
  });

  describe('canCreateProjects', () => {
    it('should return true for admin', () => {
      expect(canCreateProjects('admin')).toBe(true);
    });

    it('should return true for manager', () => {
      expect(canCreateProjects('manager')).toBe(true);
    });

    it('should return true for technician', () => {
      expect(canCreateProjects('technician')).toBe(true);
    });

    it('should return true for director', () => {
      expect(canCreateProjects('director')).toBe(true);
    });

    it('should return false for sales', () => {
      expect(canCreateProjects('sales')).toBe(false);
    });

    it('should return false for marketer', () => {
      expect(canCreateProjects('marketer')).toBe(false);
    });

    it('should return false for null', () => {
      expect(canCreateProjects(null)).toBe(false);
    });
  });

  describe('canEditProjects', () => {
    it('should return true for all roles except null', () => {
      ALL_ROLES.forEach(role => {
        expect(canEditProjects(role)).toBe(true);
      });
    });

    it('should return false for null', () => {
      expect(canEditProjects(null)).toBe(false);
    });
  });

  describe('canDeleteProjects', () => {
    it('should return true for admin', () => {
      expect(canDeleteProjects('admin')).toBe(true);
    });

    it('should return true for manager', () => {
      expect(canDeleteProjects('manager')).toBe(true);
    });

    it('should return true for director', () => {
      expect(canDeleteProjects('director')).toBe(true);
    });

    it('should return false for technician', () => {
      expect(canDeleteProjects('technician')).toBe(false);
    });

    it('should return false for sales', () => {
      expect(canDeleteProjects('sales')).toBe(false);
    });

    it('should return false for marketer', () => {
      expect(canDeleteProjects('marketer')).toBe(false);
    });

    it('should return false for null', () => {
      expect(canDeleteProjects(null)).toBe(false);
    });
  });

  describe('canManageUsers', () => {
    it('should return true only for admin', () => {
      expect(canManageUsers('admin')).toBe(true);
    });

    it('should return false for all other roles', () => {
      const nonAdminRoles: UserRole[] = ['manager', 'technician', 'director', 'sales', 'marketer'];
      nonAdminRoles.forEach(role => {
        expect(canManageUsers(role)).toBe(false);
      });
    });

    it('should return false for null', () => {
      expect(canManageUsers(null)).toBe(false);
    });
  });

  describe('isAdmin', () => {
    it('should return true for admin', () => {
      expect(isAdmin('admin')).toBe(true);
    });

    it('should return false for all other roles', () => {
      const nonAdminRoles: UserRole[] = ['manager', 'technician', 'director', 'sales', 'marketer'];
      nonAdminRoles.forEach(role => {
        expect(isAdmin(role)).toBe(false);
      });
    });

    it('should return false for null', () => {
      expect(isAdmin(null)).toBe(false);
    });
  });
});
