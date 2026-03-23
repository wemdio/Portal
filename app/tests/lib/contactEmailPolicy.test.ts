/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { sanitizeContactEmail } from '@/lib/cisLeads/contactEmailPolicy';

describe('contactEmailPolicy', () => {
  describe('sanitizeContactEmail', () => {
    it('returns null for null/undefined/empty', () => {
      expect(sanitizeContactEmail(null)).toBeNull();
      expect(sanitizeContactEmail(undefined)).toBeNull();
      expect(sanitizeContactEmail('')).toBeNull();
      expect(sanitizeContactEmail('  ')).toBeNull();
    });

    it('returns null for invalid email format', () => {
      expect(sanitizeContactEmail('notanemail')).toBeNull();
      expect(sanitizeContactEmail('foo@')).toBeNull();
      expect(sanitizeContactEmail('@bar.com')).toBeNull();
    });

    it('normalizes to lowercase', () => {
      expect(sanitizeContactEmail('Ivan.Petrov@Company.RU')).toBe('ivan.petrov@company.ru');
    });

    it('passes valid personal emails', () => {
      expect(sanitizeContactEmail('ivan.petrov@company.ru')).toBe('ivan.petrov@company.ru');
      expect(sanitizeContactEmail('a.sidorov@example.com')).toBe('a.sidorov@example.com');
      expect(sanitizeContactEmail('director@company.ru')).toBe('director@company.ru');
    });

    it('passes generic mailboxes (info@, sales@, etc.)', () => {
      expect(sanitizeContactEmail('info@company.ru')).toBe('info@company.ru');
      expect(sanitizeContactEmail('sales@company.ru')).toBe('sales@company.ru');
      expect(sanitizeContactEmail('office@company.ru')).toBe('office@company.ru');
      expect(sanitizeContactEmail('support@company.ru')).toBe('support@company.ru');
      expect(sanitizeContactEmail('hr@company.ru')).toBe('hr@company.ru');
      expect(sanitizeContactEmail('marketing@company.ru')).toBe('marketing@company.ru');
    });
  });
});
