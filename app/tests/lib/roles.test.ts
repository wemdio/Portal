import { 
  ROLE_LABELS, 
  ALL_ROLES, 
  INTERNAL_ROLES,
  canCreateProjects, 
  canEditProjects, 
  canDeleteProjects, 
  canManageUsers, 
  isAdmin,
  isClient,
  isInternalRole,
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
      expect(ROLE_LABELS.client).toBe('Клиент');
    });
  });

  describe('ALL_ROLES includes client', () => {
    it('should contain the client role', () => {
      expect(ALL_ROLES).toContain('client');
    });
  });

  describe('INTERNAL_ROLES excludes client', () => {
    it('should not contain the client role', () => {
      expect(INTERNAL_ROLES).not.toContain('client');
    });

    it('should contain all non-client roles', () => {
      const expected: UserRole[] = ['technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead'];
      expected.forEach(role => {
        expect(INTERNAL_ROLES).toContain(role);
      });
    });
  });

  describe('isClient', () => {
    it('should return true for client', () => {
      expect(isClient('client')).toBe(true);
    });

    it('should return false for all internal roles', () => {
      INTERNAL_ROLES.forEach(role => {
        expect(isClient(role)).toBe(false);
      });
    });

    it('should return false for null', () => {
      expect(isClient(null)).toBe(false);
    });
  });

  describe('isInternalRole', () => {
    it('should return true for all non-client roles', () => {
      INTERNAL_ROLES.forEach(role => {
        expect(isInternalRole(role)).toBe(true);
      });
    });

    it('should return false for client', () => {
      expect(isInternalRole('client')).toBe(false);
    });

    it('should return false for null', () => {
      expect(isInternalRole(null)).toBe(false);
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

    it('should return false for client', () => {
      expect(canCreateProjects('client')).toBe(false);
    });

    it('should return false for null', () => {
      expect(canCreateProjects(null)).toBe(false);
    });
  });

  describe('canEditProjects', () => {
    it('should return true for all internal roles', () => {
      INTERNAL_ROLES.forEach(role => {
        expect(canEditProjects(role)).toBe(true);
      });
    });

    it('should return false for client', () => {
      expect(canEditProjects('client')).toBe(false);
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

    it('should return false for client', () => {
      expect(canDeleteProjects('client')).toBe(false);
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
      const nonAdminRoles: UserRole[] = ['manager', 'technician', 'director', 'sales', 'marketer', 'lead', 'client'];
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
      const nonAdminRoles: UserRole[] = ['manager', 'technician', 'director', 'sales', 'marketer', 'lead', 'client'];
      nonAdminRoles.forEach(role => {
        expect(isAdmin(role)).toBe(false);
      });
    });

    it('should return false for null', () => {
      expect(isAdmin(null)).toBe(false);
    });
  });
});
