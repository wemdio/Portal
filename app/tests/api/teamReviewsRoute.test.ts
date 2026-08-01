/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextRequest } from 'next/server';

const LEAD_ID = '00000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_EMPLOYEE_ID = '00000000-0000-4000-8000-000000000003';
const CLIENT_ID = '00000000-0000-4000-8000-000000000004';
const DEMO_LEAD_ID = '00000000-0000-4000-8000-000000000005';
const UNKNOWN_ROLE_ID = '00000000-0000-4000-8000-000000000006';
const REVIEW_ID = '00000000-0000-4000-8000-000000000010';
const SCHEDULED_REVIEW_ID = '00000000-0000-4000-8000-000000000012';

let mockMainDb: MockSupabaseClient = createMockSupabase();
let mockCurrentUser: { id: string } | null = { id: LEAD_ID };
const mockLogAudit = jest.fn(async (..._args: unknown[]) => {});
const mockLogError = jest.fn(async (..._args: unknown[]) => {});

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => header?.replace(/^Bearer\s+/i, '') || null,
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: mockCurrentUser } })),
    },
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

function profile(
  id: string,
  role: string,
  fullName: string,
  email: string,
  avatarUrl: string | null = null,
  isDemo = false,
) {
  return {
    id,
    role,
    full_name: fullName,
    email,
    avatar_url: avatarUrl,
    is_demo: isDemo,
  };
}

function seedDatabase() {
  mockMainDb = createMockSupabase({
    tables: {
      profiles: [
        profile(LEAD_ID, 'lead', 'Лид Команды', 'lead@example.com', 'lead.png'),
        profile(EMPLOYEE_ID, 'technician', 'Анна Ким', 'anna@example.com', 'anna.png'),
        profile(OTHER_EMPLOYEE_ID, 'manager', 'Иван Петров', 'ivan@example.com'),
        profile(CLIENT_ID, 'client', 'Клиент', 'client@example.com'),
        profile(DEMO_LEAD_ID, 'lead', 'Demo Lead', 'demo@example.com', null, true),
        profile(UNKNOWN_ROLE_ID, 'external', 'Unknown Role', 'unknown@example.com'),
      ],
      employee_reviews: [
        {
          id: REVIEW_ID,
          review_date: '2026-07-24',
          employee_user_id: EMPLOYEE_ID,
          reviewer_user_id: LEAD_ID,
          status: 'completed',
          reason: null,
          outcomes: 'Уверенно ведёт проекты',
          problems: 'Нужно лучше определять приоритеты',
          recommendations: 'Разбирать кейсы раз в неделю',
          created_at: '2026-07-24T12:00:00.000Z',
          updated_at: '2026-07-24T12:00:00.000Z',
        },
        {
          id: '00000000-0000-4000-8000-000000000011',
          review_date: '2026-07-20',
          employee_user_id: OTHER_EMPLOYEE_ID,
          reviewer_user_id: null,
          status: 'completed',
          reason: null,
          outcomes: 'Хороший результат',
          problems: null,
          recommendations: null,
          created_at: '2026-07-20T12:00:00.000Z',
          updated_at: '2026-07-20T12:00:00.000Z',
        },
        {
          id: SCHEDULED_REVIEW_ID,
          review_date: '2026-08-12',
          employee_user_id: EMPLOYEE_ID,
          reviewer_user_id: LEAD_ID,
          status: 'scheduled',
          reason: 'Проверить адаптацию на новых проектах',
          outcomes: null,
          problems: null,
          recommendations: null,
          created_at: '2026-07-31T12:00:00.000Z',
          updated_at: '2026-07-31T12:00:00.000Z',
        },
      ],
    },
  });
}

function request(
  path: string,
  init: { method?: string; body?: unknown; authenticated?: boolean } = {},
) {
  const headers = new Headers();
  if (init.authenticated !== false) headers.set('authorization', 'Bearer test-token');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`http://portal.local${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  jest.resetModules();
  mockCurrentUser = { id: LEAD_ID };
  mockLogAudit.mockClear();
  mockLogError.mockClear();
  seedDatabase();
});

describe('GET /api/team/reviews', () => {
  it('returns all reviews and internal employees to leadership in the canonical camelCase shape', async () => {
    const { GET } = await import('@/app/api/team/reviews/route');

    const response = await GET(request('/api/team/reviews'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        canManage: true,
        currentUserId: LEAD_ID,
      }),
    );
    expect(body.employees).toEqual([
      {
        id: LEAD_ID,
        name: 'Лид Команды',
        email: 'lead@example.com',
        role: 'lead',
        avatarUrl: 'lead.png',
      },
      {
        id: EMPLOYEE_ID,
        name: 'Анна Ким',
        email: 'anna@example.com',
        role: 'technician',
        avatarUrl: 'anna.png',
      },
      {
        id: OTHER_EMPLOYEE_ID,
        name: 'Иван Петров',
        email: 'ivan@example.com',
        role: 'manager',
        avatarUrl: null,
      },
    ]);
    expect(body.reviews).toEqual(
      expect.arrayContaining([
        {
          id: REVIEW_ID,
          reviewDate: '2026-07-24',
          employee: {
            id: EMPLOYEE_ID,
            name: 'Анна Ким',
            email: 'anna@example.com',
            role: 'technician',
            avatarUrl: 'anna.png',
          },
          reviewer: {
            id: LEAD_ID,
            name: 'Лид Команды',
            email: 'lead@example.com',
            role: 'lead',
            avatarUrl: 'lead.png',
          },
          status: 'completed',
          reason: null,
          outcomes: 'Уверенно ведёт проекты',
          problems: 'Нужно лучше определять приоритеты',
          recommendations: 'Разбирать кейсы раз в неделю',
          createdAt: '2026-07-24T12:00:00.000Z',
          updatedAt: '2026-07-24T12:00:00.000Z',
        },
        expect.objectContaining({
          employee: expect.objectContaining({ id: OTHER_EMPLOYEE_ID }),
          reviewer: null,
          status: 'completed',
          reason: null,
        }),
        expect.objectContaining({
          id: SCHEDULED_REVIEW_ID,
          reviewDate: '2026-08-12',
          employee: expect.objectContaining({ id: EMPLOYEE_ID }),
          reviewer: expect.objectContaining({ id: LEAD_ID }),
          status: 'scheduled',
          reason: 'Проверить адаптацию на новых проектах',
          outcomes: null,
          problems: null,
          recommendations: null,
        }),
      ]),
    );
  });

  it('loads every review past the PostgREST 1000-row page limit', async () => {
    const baseDb = mockMainDb;
    const firstReview = baseDb.getRows('employee_reviews')[0];
    const reviewRows = Array.from({ length: 1001 }, (_, index) => ({
      ...firstReview,
      id: `review-${index}`,
      review_date: index === 1000 ? '2025-01-01' : '2026-07-24',
    }));
    const ranges: Array<[number, number]> = [];
    const employeeReviewsBuilder = {
      select: () => employeeReviewsBuilder,
      eq: () => employeeReviewsBuilder,
      order: () => employeeReviewsBuilder,
      range: async (from: number, to: number) => {
        ranges.push([from, to]);
        return { data: reviewRows.slice(from, to + 1), error: null, count: reviewRows.length };
      },
      then: <T>(
        onFulfilled?: (value: { data: typeof reviewRows; error: null; count: number }) => T,
        onRejected?: (reason: unknown) => T,
      ) => Promise.resolve({
        data: reviewRows.slice(0, 1000),
        error: null,
        count: reviewRows.length,
      }).then(onFulfilled, onRejected),
    };
    mockMainDb = {
      ...baseDb,
      from: (table: string) => table === 'employee_reviews'
        ? employeeReviewsBuilder as never
        : baseDb.from(table),
    };

    const { GET } = await import('@/app/api/team/reviews/route');
    const response = await GET(request('/api/team/reviews'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reviews).toHaveLength(1001);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
  });
  it('denies non-leadership employees instead of exposing their own reviews', async () => {
    mockCurrentUser = { id: EMPLOYEE_ID };
    const { GET } = await import('@/app/api/team/reviews/route');

    const response = await GET(request('/api/team/reviews'));

    expect(response.status).toBe(403);
  });

  it('rejects a demo account even if its stored role is leadership', async () => {
    mockCurrentUser = { id: DEMO_LEAD_ID };
    const { GET } = await import('@/app/api/team/reviews/route');

    const response = await GET(request('/api/team/reviews'));

    expect(response.status).toBe(403);
  });

  it('rejects profiles with an unknown non-client role', async () => {
    mockCurrentUser = { id: UNKNOWN_ROLE_ID };
    const { GET } = await import('@/app/api/team/reviews/route');

    const response = await GET(request('/api/team/reviews'));

    expect(response.status).toBe(403);
  });

  it('rejects clients and anonymous callers', async () => {
    mockCurrentUser = { id: CLIENT_ID };
    const { GET } = await import('@/app/api/team/reviews/route');

    const clientResponse = await GET(request('/api/team/reviews'));
    expect(clientResponse.status).toBe(403);

    mockCurrentUser = null;
    const anonymousResponse = await GET(
      request('/api/team/reviews', { authenticated: false }),
    );
    expect(anonymousResponse.status).toBe(401);
  });
});

describe('POST /api/team/reviews', () => {
  it('schedules a review with date, employee and optional reason', async () => {
    const { POST } = await import('@/app/api/team/reviews/route');

    const response = await POST(
      request('/api/team/reviews', {
        method: 'POST',
        body: {
          reviewDate: '2026-08-12',
          employeeUserId: EMPLOYEE_ID,
          reason: '  Проверить адаптацию  ',
          reviewerUserId: OTHER_EMPLOYEE_ID,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockMainDb.inserts).toContainEqual({
      table: 'employee_reviews',
      rows: [
        expect.objectContaining({
          review_date: '2026-08-12',
          employee_user_id: EMPLOYEE_ID,
          reviewer_user_id: LEAD_ID,
          status: 'scheduled',
          reason: 'Проверить адаптацию',
          outcomes: null,
          problems: null,
          recommendations: null,
        }),
      ],
    });
    expect(body.review).toEqual(
      expect.objectContaining({
        reviewDate: '2026-08-12',
        employee: expect.objectContaining({ id: EMPLOYEE_ID, name: 'Анна Ким' }),
        reviewer: expect.objectContaining({ id: LEAD_ID, name: 'Лид Команды' }),
        status: 'scheduled',
        reason: 'Проверить адаптацию',
        outcomes: null,
        problems: null,
        recommendations: null,
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.reviews.create.success',
      'Employee review created',
      expect.objectContaining({
        reviewId: expect.any(String),
        employeeUserId: EMPLOYEE_ID,
        reviewDate: '2026-08-12',
      }),
      expect.objectContaining({ userId: LEAD_ID }),
    );
  });

  it('keeps legacy completion fields and creates the review as completed', async () => {
    const { POST } = await import('@/app/api/team/reviews/route');

    const response = await POST(
      request('/api/team/reviews', {
        method: 'POST',
        body: {
          reviewDate: '2026-08-14',
          employeeUserId: EMPLOYEE_ID,
          outcomes: '  Успешно адаптировалась  ',
          problems: '  Приоритеты  ',
          recommendations: '  Еженедельные разборы  ',
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockMainDb.getRows('employee_reviews')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          review_date: '2026-08-14',
          employee_user_id: EMPLOYEE_ID,
          reviewer_user_id: LEAD_ID,
          status: 'completed',
          outcomes: 'Успешно адаптировалась',
          problems: 'Приоритеты',
          recommendations: 'Еженедельные разборы',
        }),
      ]),
    );
    expect(body.review).toEqual(
      expect.objectContaining({
        status: 'completed',
        outcomes: 'Успешно адаптировалась',
        problems: 'Приоритеты',
        recommendations: 'Еженедельные разборы',
      }),
    );
  });

  it('accepts a 500-character reason and normalizes a blank reason to null', async () => {
    const { POST } = await import('@/app/api/team/reviews/route');

    const maxReasonResponse = await POST(
      request('/api/team/reviews', {
        method: 'POST',
        body: {
          reviewDate: '2026-08-12',
          employeeUserId: EMPLOYEE_ID,
          reason: 'x'.repeat(500),
        },
      }),
    );
    expect(maxReasonResponse.status).toBe(201);

    const blankReasonResponse = await POST(
      request('/api/team/reviews', {
        method: 'POST',
        body: {
          reviewDate: '2026-08-13',
          employeeUserId: EMPLOYEE_ID,
          reason: '   ',
        },
      }),
    );
    expect(blankReasonResponse.status).toBe(201);
    expect(mockMainDb.getRows('employee_reviews')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ review_date: '2026-08-12', reason: 'x'.repeat(500) }),
        expect.objectContaining({ review_date: '2026-08-13', reason: null }),
      ]),
    );
  });

  it('allows only leadership to create reviews', async () => {
    mockCurrentUser = { id: EMPLOYEE_ID };
    const { POST } = await import('@/app/api/team/reviews/route');

    const response = await POST(
      request('/api/team/reviews', {
        method: 'POST',
        body: {
          reviewDate: '2026-07-29',
          employeeUserId: EMPLOYEE_ID,
          outcomes: 'Итоги',
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(mockMainDb.inserts).toHaveLength(0);
  });

  it.each([
    [{ reviewDate: '29.07.2026', employeeUserId: EMPLOYEE_ID }, 'reviewDate'],
    [{ reviewDate: '2026-02-30', employeeUserId: EMPLOYEE_ID }, 'reviewDate'],
    [{ reviewDate: '2026-08-12', employeeUserId: 'not-a-uuid' }, 'employeeUserId'],
    [
      { reviewDate: '2026-08-12', employeeUserId: EMPLOYEE_ID, reason: 'x'.repeat(501) },
      'reason',
    ],
  ])('rejects invalid schedule payload %# without writing', async (payload, field) => {
    const { POST } = await import('@/app/api/team/reviews/route');

    const response = await POST(
      request('/api/team/reviews', { method: 'POST', body: payload }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain(field);
    expect(mockMainDb.inserts).toHaveLength(0);
  });

  it('rejects a client as the reviewed employee', async () => {
    const { POST } = await import('@/app/api/team/reviews/route');

    const response = await POST(
      request('/api/team/reviews', {
        method: 'POST',
        body: {
          reviewDate: '2026-07-29',
          employeeUserId: CLIENT_ID,
          outcomes: 'Итоги',
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(mockMainDb.inserts).toHaveLength(0);
  });


  it('rejects an unknown role as the reviewed employee', async () => {
    const { POST } = await import('@/app/api/team/reviews/route');

    const response = await POST(
      request('/api/team/reviews', {
        method: 'POST',
        body: {
          reviewDate: '2026-07-29',
          employeeUserId: UNKNOWN_ROLE_ID,
          outcomes: 'Итоги',
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(mockMainDb.inserts).toHaveLength(0);
  });
});

describe('PATCH /api/team/reviews/[id]', () => {
  it('edits scheduled review metadata without filling post-meeting fields', async () => {
    const { PATCH } = await import('@/app/api/team/reviews/[id]/route');

    const response = await PATCH(
      request('/api/team/reviews/' + SCHEDULED_REVIEW_ID, {
        method: 'PATCH',
        body: {
          reviewDate: '2026-08-15',
          employeeUserId: OTHER_EMPLOYEE_ID,
          reason: '  Обсудить новые зоны ответственности  ',
        },
      }),
      { params: Promise.resolve({ id: SCHEDULED_REVIEW_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockMainDb.getRows('employee_reviews')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: SCHEDULED_REVIEW_ID,
          review_date: '2026-08-15',
          employee_user_id: OTHER_EMPLOYEE_ID,
          reviewer_user_id: LEAD_ID,
          status: 'scheduled',
          reason: 'Обсудить новые зоны ответственности',
          outcomes: null,
          problems: null,
          recommendations: null,
        }),
      ]),
    );
    expect(body.review).toEqual(
      expect.objectContaining({
        id: SCHEDULED_REVIEW_ID,
        status: 'scheduled',
        reason: 'Обсудить новые зоны ответственности',
        outcomes: null,
      }),
    );
  });

  it('completes a scheduled review atomically and exposes it as completed', async () => {
    const { PATCH } = await import('@/app/api/team/reviews/[id]/route');

    const response = await PATCH(
      request('/api/team/reviews/' + SCHEDULED_REVIEW_ID, {
        method: 'PATCH',
        body: {
          status: 'completed',
          outcomes: '  Уверенно взяла новые проекты  ',
          problems: '   ',
          recommendations: '  Продолжить еженедельные разборы  ',
        },
      }),
      { params: Promise.resolve({ id: SCHEDULED_REVIEW_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockMainDb.getRows('employee_reviews')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: SCHEDULED_REVIEW_ID,
          reviewer_user_id: LEAD_ID,
          status: 'completed',
          outcomes: 'Уверенно взяла новые проекты',
          problems: null,
          recommendations: 'Продолжить еженедельные разборы',
        }),
      ]),
    );
    expect(body.review).toEqual(
      expect.objectContaining({
        id: SCHEDULED_REVIEW_ID,
        status: 'completed',
        outcomes: 'Уверенно взяла новые проекты',
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.reviews.update.success',
      'Employee review updated',
      expect.objectContaining({
        reviewId: SCHEDULED_REVIEW_ID,
        changedFields: expect.arrayContaining([
          'status',
          'outcomes',
          'problems',
          'recommendations',
        ]),
      }),
      expect.objectContaining({ userId: LEAD_ID }),
    );
  });

  it('updates allowed fields, preserves completed status and reviewer, and audits the change', async () => {
    const { PATCH } = await import('@/app/api/team/reviews/[id]/route');

    const response = await PATCH(
      request(`/api/team/reviews/${REVIEW_ID}`, {
        method: 'PATCH',
        body: {
          reviewDate: '2026-07-29',
          employeeUserId: OTHER_EMPLOYEE_ID,
          reviewerUserId: OTHER_EMPLOYEE_ID,
          reason: '  План развития  ',
          outcomes: 'Обновлённые итоги',
          problems: '',
          recommendations: 'Продолжить практику',
        },
      }),
      { params: Promise.resolve({ id: REVIEW_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockMainDb.getRows('employee_reviews')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: REVIEW_ID,
          review_date: '2026-07-29',
          employee_user_id: OTHER_EMPLOYEE_ID,
          reviewer_user_id: LEAD_ID,
          status: 'completed',
          reason: 'План развития',
          outcomes: 'Обновлённые итоги',
          problems: null,
          recommendations: 'Продолжить практику',
        }),
      ]),
    );
    expect(body.review).toEqual(
      expect.objectContaining({
        id: REVIEW_ID,
        employee: expect.objectContaining({ id: OTHER_EMPLOYEE_ID }),
        reviewer: expect.objectContaining({ id: LEAD_ID }),
        status: 'completed',
        reason: 'План развития',
        outcomes: 'Обновлённые итоги',
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      'team.reviews.update.success',
      'Employee review updated',
      expect.objectContaining({
        reviewId: REVIEW_ID,
        changedFields: expect.arrayContaining([
          'review_date',
          'employee_user_id',
          'reason',
          'outcomes',
          'problems',
          'recommendations',
        ]),
      }),
      expect.objectContaining({ userId: LEAD_ID }),
    );
  });

  it.each([
    [
      'requires outcomes when completing a scheduled review',
      SCHEDULED_REVIEW_ID,
      { status: 'completed' },
      'outcomes',
    ],
    [
      'does not accept result fields while a review stays scheduled',
      SCHEDULED_REVIEW_ID,
      { outcomes: 'Преждевременные итоги' },
      'status',
    ],
    [
      'rejects an unknown lifecycle status',
      SCHEDULED_REVIEW_ID,
      { status: 'cancelled' },
      'status',
    ],
    [
      'does not move a completed review back to scheduled',
      REVIEW_ID,
      { status: 'scheduled' },
      'transition',
    ],
    [
      'rejects a reason longer than 500 characters',
      SCHEDULED_REVIEW_ID,
      { reason: 'x'.repeat(501) },
      'reason',
    ],
    [
      'does not allow clearing outcomes from a completed review',
      REVIEW_ID,
      { outcomes: '   ' },
      'outcomes',
    ],
  ])('%s', async (_title, reviewId, payload, errorField) => {
    const { PATCH } = await import('@/app/api/team/reviews/[id]/route');

    const response = await PATCH(
      request('/api/team/reviews/' + reviewId, {
        method: 'PATCH',
        body: payload,
      }),
      { params: Promise.resolve({ id: reviewId }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.toLowerCase()).toContain(errorField);
    expect(mockMainDb.updates).toHaveLength(0);
  });

  it('allows only leadership to update reviews', async () => {
    mockCurrentUser = { id: EMPLOYEE_ID };
    const { PATCH } = await import('@/app/api/team/reviews/[id]/route');

    const response = await PATCH(
      request(`/api/team/reviews/${REVIEW_ID}`, {
        method: 'PATCH',
        body: { outcomes: 'Попытка изменения' },
      }),
      { params: Promise.resolve({ id: REVIEW_ID }) },
    );

    expect(response.status).toBe(403);
    expect(mockMainDb.updates).toHaveLength(0);
  });

  it('returns 404 for an unknown review', async () => {
    const { PATCH } = await import('@/app/api/team/reviews/[id]/route');

    const response = await PATCH(
      request('/api/team/reviews/00000000-0000-4000-8000-000000000099', {
        method: 'PATCH',
        body: { outcomes: 'Итоги' },
      }),
      {
        params: Promise.resolve({
          id: '00000000-0000-4000-8000-000000000099',
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(mockMainDb.updates).toHaveLength(0);
  });

  it('rejects an empty patch', async () => {
    const { PATCH } = await import('@/app/api/team/reviews/[id]/route');

    const response = await PATCH(
      request(`/api/team/reviews/${REVIEW_ID}`, { method: 'PATCH', body: {} }),
      { params: Promise.resolve({ id: REVIEW_ID }) },
    );

    expect(response.status).toBe(400);
    expect(mockMainDb.updates).toHaveLength(0);
  });
});
