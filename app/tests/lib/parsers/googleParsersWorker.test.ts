/** @jest-environment node */

import { placeResultToRow, newsResultToRow, streamSse } from '@/../lib/parsers/googleParsersWorker';

describe('placeResultToRow', () => {
  test('maps parser PlaceResult to google_maps_places row shape', () => {
    const row = placeResultToRow('job-1', {
      query: 'cafes Berlin', city: '', category: 'cafe',
      name: 'Cafe X', address: '1 Str, Berlin', phone: '+49 123',
      website: 'https://cafex.de', emails: ['hi@cafex.de'], socials: [],
      linkedInUrl: 'https://linkedin.com/company/cafex',
      rating: '4.5', reviewsCount: '128',
      googleMapsUrl: 'https://maps.google.com/?cid=1', placeId: 'cid:1',
      googleId: 'gid:1', latitude: '52.5', longitude: '13.4',
      dedupeKey: 'cid:1', sourceUrl: 'cafes Berlin', status: 'ok',
    });
    expect(row.job_id).toBe('job-1');
    expect(row.name).toBe('Cafe X');
    expect(row.emails).toEqual(['hi@cafex.de']);
    expect(row.reviews_count).toBe(128);
    expect(row.latitude).toBe(52.5);
    expect(row.dedupe_key).toBe('cid:1');
  });

  test('empty reviews_count → null (not zero)', () => {
    const row = placeResultToRow('job-1', {
      query: '', city: '', category: '', name: '', address: '', phone: '',
      website: '', emails: [], socials: [], linkedInUrl: '',
      rating: '', reviewsCount: '', googleMapsUrl: '', placeId: '',
      googleId: '', latitude: '', longitude: '',
      dedupeKey: 'abc', sourceUrl: '', status: 'partial',
    });
    expect(row.reviews_count).toBeNull();
    expect(row.latitude).toBeNull();
  });
});

describe('newsResultToRow', () => {
  test('maps NewsResult to google_news_results row', () => {
    const row = newsResultToRow('job-2', {
      query: 'AI news', position: 3, title: 'Big AI update',
      body: 'Body text', posted: '2h ago', source: 'TechNews',
      link: 'https://techn.com/x',
    });
    expect(row.job_id).toBe('job-2');
    expect(row.position).toBe(3);
    expect(row.link).toBe('https://techn.com/x');
  });
});

describe('streamSse', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('ignores heartbeat comments and handles CRLF frames', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
        controller.enqueue(encoder.encode('event: progress\r\ndata: {"currentTargetIndex":1}\r\n\r\n'));
        controller.close();
      },
    });
    global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const progress = jest.fn();

    await streamSse('http://parser/run/maps', {}, { progress });

    expect(progress).toHaveBeenCalledWith({ currentTargetIndex: 1 });
  });

  test('fails early on a non-success service response', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));

    await expect(streamSse('http://parser/run/maps', {}, {}))
      .rejects.toThrow('parser service returned HTTP 502');
  });
});
