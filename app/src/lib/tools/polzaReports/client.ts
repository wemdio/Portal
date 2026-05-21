import 'server-only';

import type { ColdyCredentials, PolzaColdyEvent } from './types';

/**
 * Thin HTTP client for the `polza-reports` Python microservice.
 *
 * Only the portal container talks to this service — it lives in the internal
 * docker network and is not authenticated, so we never expose its URL to the
 * browser. All calls happen from Next.js API routes (server-only).
 */

function getServiceUrl(): string {
  const url = (process.env.POLZA_REPORTS_URL ?? '').trim();
  if (!url) {
    throw new Error(
      'POLZA_REPORTS_URL is not configured. Set it to the internal address of the polza-reports service (e.g. http://polza-reports:8000).',
    );
  }
  return url.replace(/\/+$/, '');
}

export interface ColdyReportOptions {
  detailed: boolean;
  include_created: boolean;
  include_base_left: boolean;
}

export type ColdyEventHandler = (event: PolzaColdyEvent) => void | Promise<void>;

/**
 * Stream a Coldy report from the microservice and forward SSE events to the caller.
 *
 * Returns the rendered xlsx as Buffer + campaign count, OR throws if the stream
 * yields an `error` event or terminates without a `result`.
 *
 * The caller passes `onEvent` to forward each event upstream to the browser
 * (e.g. into another SSE controller). We don't expose the raw Response — the
 * microservice reply lives only inside this function.
 */
export async function streamColdyReport(
  credentials: ColdyCredentials,
  options: ColdyReportOptions,
  onEvent: ColdyEventHandler,
  signal?: AbortSignal,
): Promise<{ xlsx: Buffer; campaignsCount: number }> {
  const res = await fetch(`${getServiceUrl()}/reports/coldy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
      url: credentials.url,
      detailed: options.detailed,
      include_created: options.include_created,
      include_base_left: options.include_base_left,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `polza-reports /reports/coldy returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: { xlsx: Buffer; campaignsCount: number } | null = null;
  let errorMessage: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line ("\n\n"). Anything left over is
    // a partial frame that we keep for the next chunk.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue; // skip comments / heartbeats
      let event: PolzaColdyEvent;
      try {
        event = JSON.parse(dataLine.slice(6)) as PolzaColdyEvent;
      } catch {
        continue;
      }

      await onEvent(event);

      if (event.type === 'result') {
        finalResult = {
          xlsx: Buffer.from(event.xlsx_b64, 'base64'),
          campaignsCount: event.campaigns_count,
        };
      } else if (event.type === 'error') {
        errorMessage = event.message || 'Unknown error from polza-reports';
      }
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!finalResult) {
    throw new Error('polza-reports stream ended without a result event');
  }
  return finalResult;
}

export interface TriggaReportOptions {
  include_created: boolean;
  include_base_left: boolean;
}

/**
 * Forward a Trigga CSV to the microservice and return the rendered xlsx.
 * Synchronous (no SSE) — Trigga reports are CPU-only and quick.
 */
export async function generateTriggaReport(
  csv: Buffer,
  filename: string,
  options: TriggaReportOptions,
  signal?: AbortSignal,
): Promise<{ xlsx: Buffer; campaignsCount: number }> {
  const form = new FormData();
  // Node 20 FormData expects Blob. Buffer's underlying ArrayBufferLike isn't
  // assignable to BlobPart's ArrayBuffer, so we copy into a plain Uint8Array
  // backed by a non-shared ArrayBuffer.
  const view = new Uint8Array(csv.byteLength);
  view.set(csv);
  form.append('file', new Blob([view], { type: 'text/csv' }), filename || 'trigga.csv');
  form.append('include_created', String(options.include_created));
  form.append('include_base_left', String(options.include_base_left));

  const res = await fetch(`${getServiceUrl()}/reports/trigga`, {
    method: 'POST',
    body: form,
    signal,
  });

  if (!res.ok) {
    let message = `polza-reports /reports/trigga returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body?.detail) message = body.detail;
    } catch {
      // body wasn't JSON; keep the generic message
    }
    throw new Error(message);
  }

  const arrayBuffer = await res.arrayBuffer();
  const campaignsHeader = res.headers.get('x-campaigns-count');
  return {
    xlsx: Buffer.from(arrayBuffer),
    campaignsCount: Number(campaignsHeader ?? 0) || 0,
  };
}
