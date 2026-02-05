import { UserRole, UserProfile, Project, ProjectStatus } from '@/types';

describe('Type definitions', () => {
  describe('UserRole', () => {
    it('should accept valid role values', () => {
      const validRoles: UserRole[] = ['admin', 'manager', 'technician', 'director', 'sales', 'marketer'];
      validRoles.forEach(role => {
        expect(role).toBeDefined();
      });
    });
  });

  describe('UserProfile', () => {
    it('should have required id field', () => {
      const profile: UserProfile = {
        id: 'test-id',
        role: 'admin',
      };
      expect(profile.id).toBe('test-id');
    });

    it('should have optional fields', () => {
      const profile: UserProfile = {
        id: 'test-id',
        email: 'test@example.com',
        full_name: 'Test User',
        role: 'admin',
      };
      expect(profile.email).toBe('test@example.com');
      expect(profile.full_name).toBe('Test User');
    });
  });

  describe('Project', () => {
    it('should have required fields', () => {
      const project: Project = {
        id: 'project-id',
        name: 'Test Project',
        status: 'В работе',
      };
      expect(project.id).toBe('project-id');
      expect(project.name).toBe('Test Project');
      expect(project.status).toBe('В работе');
    });
  });

  describe('ProjectStatus', () => {
    it('should accept valid status values', () => {
      const validStatuses: ProjectStatus[] = [
        'В работе',
        'Тестирование',
        'На паузе',
        'Подготовка',
        'Завершен',
        'Отменен',
      ];
      validStatuses.forEach(status => {
        expect(status).toBeDefined();
      });
    });
  });
});
