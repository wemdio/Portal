/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import { formatTeamProjectLabel } from '@/lib/teamProjectLabel';

const teamPagePath = path.resolve(__dirname, '../../src/app/team/page.tsx');
const reviewRequestHelperPath = path.resolve(
  __dirname,
  '../../src/app/api/team/review-requests/helpers.ts',
);

describe('formatTeamProjectLabel', () => {
  it.each([
    ['different labels', ' Acme ', ' Аутрич ', 'Acme · Аутрич'],
    ['same trimmed labels', ' Polza ', 'Polza', 'Polza'],
    ['same labels with different casing', ' Acme ', 'aCmE', 'Acme'],
    ['client only', ' Solo ', '   ', 'Solo'],
    ['service only', '   ', ' Аутрич ', 'Аутрич'],
    ['blank project', '   ', '\t', 'Проект'],
    ['missing project', null, undefined, 'Проект'],
  ])('%s', (_case, client, service, expected) => {
    expect(formatTeamProjectLabel(client, service)).toBe(expected);
  });

  it('is the single formatter used by both TeamPage and the private backend inbox', () => {
    const pageSource = fs.readFileSync(teamPagePath, 'utf8');
    const helperSource = fs.readFileSync(reviewRequestHelperPath, 'utf8');

    expect(pageSource).toContain("from '@/lib/teamProjectLabel'");
    expect(pageSource).toContain('formatTeamProjectLabel(project.client, project.name)');
    expect(pageSource).not.toContain('function reviewRequestProjectLabel');

    expect(helperSource).toContain("from '@/lib/teamProjectLabel'");
    expect(helperSource).toContain('formatTeamProjectLabel(project.client, project.name)');
  });

  it('uses the canonical internal-role predicate for review-request employee options', () => {
    const pageSource = fs.readFileSync(teamPagePath, 'utf8');

    expect(pageSource).toContain("import { isInternalRole } from '@/lib/roles'");
    expect(pageSource).toContain('isInternalRole(profile.role)');
    expect(pageSource).not.toContain('INTERNAL_REVIEW_EMPLOYEE_ROLES');
  });
});
