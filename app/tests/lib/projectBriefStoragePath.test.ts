import {
  buildBriefStoragePath,
  sanitizeBriefFileName,
  sanitizeProjectIdForPath,
  BRIEF_PROJECTS_PREFIX,
} from '@/lib/projectBriefHypotheses/storage';

describe('project brief storage path', () => {
  it('кладёт файл под префикс projects/{projectId}/', () => {
    const path = buildBriefStoragePath({
      projectId: 'abc-123',
      fileName: 'brief.pdf',
      timestamp: 1700000000000,
    });
    expect(path.startsWith(`${BRIEF_PROJECTS_PREFIX}/abc-123/`)).toBe(true);
    expect(path.endsWith('-brief.pdf')).toBe(true);
  });

  it('содержит timestamp в имени файла', () => {
    const path = buildBriefStoragePath({
      projectId: 'abc-123',
      fileName: 'brief.pdf',
      timestamp: 1700000000000,
    });
    expect(path).toContain('1700000000000');
  });

  it('блокирует path traversal в filename', () => {
    const path = buildBriefStoragePath({
      projectId: 'pid',
      fileName: '../../etc/passwd',
      timestamp: 1,
    });
    expect(path).not.toContain('..');
    expect(path).not.toContain('etc/passwd');
  });

  it('блокирует path traversal в projectId', () => {
    const path = buildBriefStoragePath({
      projectId: '../bad',
      fileName: 'b.pdf',
      timestamp: 1,
    });
    expect(path).not.toContain('..');
    expect(path).toMatch(/^projects\/[a-z0-9_-]+\//i);
  });

  it('заменяет пробелы и небезопасные символы на дефис, оставляет кириллицу', () => {
    const safe = sanitizeBriefFileName('Бриф для клиента 2026-04.pdf');
    expect(safe).toBe('Бриф-для-клиента-2026-04.pdf');
  });

  it('добавляет .pdf если расширение отсутствует', () => {
    const safe = sanitizeBriefFileName('document');
    expect(safe.toLowerCase().endsWith('.pdf')).toBe(true);
  });

  it('сохраняет .pdf если уже есть', () => {
    const safe = sanitizeBriefFileName('hello.pdf');
    expect(safe).toBe('hello.pdf');
  });

  it('режет слишком длинные имена и сохраняет .pdf', () => {
    const longName = 'a'.repeat(300) + '.pdf';
    const safe = sanitizeBriefFileName(longName);
    expect(safe.length).toBeLessThanOrEqual(120);
    expect(safe.toLowerCase().endsWith('.pdf')).toBe(true);
  });

  it('sanitizeProjectIdForPath отбрасывает слэши и точки', () => {
    expect(sanitizeProjectIdForPath('../etc')).not.toContain('..');
    expect(sanitizeProjectIdForPath('a/b/c')).not.toContain('/');
    expect(sanitizeProjectIdForPath('valid-uuid_123')).toBe('valid-uuid_123');
  });

  it('возвращает дефолтное имя если sanitize даёт пустую строку', () => {
    const safe = sanitizeBriefFileName('///...///');
    expect(safe.toLowerCase().endsWith('.pdf')).toBe(true);
    expect(safe.length).toBeGreaterThan(4);
  });
});
