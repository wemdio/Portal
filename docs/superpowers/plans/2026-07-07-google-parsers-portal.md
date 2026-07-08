# Google Maps + Google News Parsers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the standalone `google-maps-news-parsers` tool (React+Express+Playwright) into the portal as two new tabs on `/parsers`, replicating the Yandex Maps pattern (Supabase-backed jobs, docker worker, Playwright service).

**Architecture:** Standard three-tier portal parser pattern — (1) Next.js UI and API routes read/write `google_maps_*` and `google_news_*` Supabase tables, (2) `worker-googleparsers` docker container polls those tables and drives job execution, (3) `services/googleparsers/` Node+Playwright container does the actual scraping over HTTP.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Supabase (self-hosted Postgres at `144.31.54.166`), Docker Compose, Playwright 1.49, Express 4, Tailwind CSS, Vitest.

**Reference spec:** [docs/superpowers/specs/2026-07-07-google-parsers-portal-design.md](../specs/2026-07-07-google-parsers-portal-design.md)

**Reference implementation to copy from:** Yandex Maps parser
- `app/src/components/parsers/YandexMapsParserView.tsx` (UI)
- `app/src/components/parsers/YandexMapsParserForm.tsx` (form)
- `app/src/app/api/parsers/yandexmaps/route.ts` + `[jobId]/*` (API)
- `app/worker/yandexmaps.ts` + `app/lib/parsers/yandexMapsWorker.ts` (worker glue)
- `services/yandexmaps/` (Python service; ours will be TS)
- `supabase/migrations/20260213_0003_create_yandex_maps_tables.sql` (schema pattern)

**Source of parser logic:** `G:\PycharmProjects\google-maps-news-parsers`
- `server/parser/googleMapsParser.ts` + `googleNewsParser.ts` + `contactEnrichment.ts` — copy verbatim
- `shared/googleMaps.ts` + `googleNews.ts` + `normalize.ts` + `types.ts` + `export.ts` — copy verbatim

---

## File Structure

Files created (24) and modified (5):

**Database:**
- Create: `supabase/migrations/20260707_0001_create_google_parsers_tables.sql`

**Parser service (new docker image):**
- Create: `services/googleparsers/Dockerfile`
- Create: `services/googleparsers/package.json`
- Create: `services/googleparsers/tsconfig.json`
- Create: `services/googleparsers/src/server.ts` — Express + WebSocket API (port 8001)
- Create: `services/googleparsers/src/shared/types.ts` — copied from source
- Create: `services/googleparsers/src/shared/googleMaps.ts` — copied from source
- Create: `services/googleparsers/src/shared/googleNews.ts` — copied from source
- Create: `services/googleparsers/src/shared/normalize.ts` — copied from source
- Create: `services/googleparsers/src/shared/export.ts` — copied from source
- Create: `services/googleparsers/src/parser/googleMapsParser.ts` — copied from source
- Create: `services/googleparsers/src/parser/googleNewsParser.ts` — copied from source
- Create: `services/googleparsers/src/parser/googleNewsRss.ts` — copied from source (sibling of googleNewsParser)
- Create: `services/googleparsers/src/parser/contactEnrichment.ts` — copied from source

**Portal shared types:**
- Create: `app/src/types/googleParsers.ts` — row shapes, DTOs, statuses

(For proxy encryption we reuse the portal's existing `encryptJsonAes256Gcm` / `decryptJsonAes256Gcm` from `app/src/lib/cryptoGcm.ts`.)

**Portal worker glue:**
- Create: `app/lib/parsers/googleParsersWorker.ts` — `runGoogleMapsJob(jobId)`, `runGoogleNewsJob(jobId)`
- Create: `app/worker/googleparsers.ts` — poll loop, matches `worker/yandexmaps.ts`
- Modify: `app/worker/runner.ts` — add `case 'googleparsers'`
- Modify: `Dockerfile.worker` — add `worker/googleparsers.ts` to esbuild bundle list

**Next.js API routes (Maps):**
- Create: `app/src/app/api/parsers/googlemaps/route.ts` — GET list, POST create
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/route.ts` — GET one
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/pause/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/resume/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/stop/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/results/route.ts` — paginated
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/export/route.ts` — CSV / JSON
- Create: `app/src/app/api/parsers/googlemaps/queue-status/route.ts`

**Next.js API routes (News):** symmetric mirror
- Create: `app/src/app/api/parsers/googlenews/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/pause/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/resume/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/stop/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/results/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/export/route.ts`
- Create: `app/src/app/api/parsers/googlenews/queue-status/route.ts`

**Portal UI:**
- Create: `app/src/components/parsers/GoogleMapsParserView.tsx`
- Create: `app/src/components/parsers/GoogleMapsParserForm.tsx`
- Create: `app/src/components/parsers/GoogleNewsParserView.tsx`
- Create: `app/src/components/parsers/GoogleNewsParserForm.tsx`
- Modify: `app/src/app/parsers/page.tsx` — add two tabs

**Docker compose / deploy:**
- Modify: `docker-compose.prod.yml` — add `googleparsers`, `worker-googleparsers`
- Modify: `docker-compose.yml` — add same for local dev

**Tests:**
- Create: `app/tests/lib/parsers/googleParsersWorker.test.ts` — unit tests for row mapping (place + news)

---

## Phase 1 — Database Schema

### Task 1.1: Write the migration

**Files:**
- Create: `supabase/migrations/20260707_0001_create_google_parsers_tables.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- google_maps_jobs
create table public.google_maps_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in (
    'queued','running','paused','stopped','completed','failed',
    'captcha','blocked','timeout','login_required'
  )),
  config jsonb not null default '{}'::jsonb,
  message text,
  total_targets integer not null default 0,
  processed_targets integer not null default 0,
  total_results integer not null default 0,
  proxy_enabled boolean not null default false,
  proxy_encrypted text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

create index idx_google_maps_jobs_user_id_created_at
  on public.google_maps_jobs(user_id, created_at desc);
create index idx_google_maps_jobs_status
  on public.google_maps_jobs(status)
  where status in ('queued', 'running');

-- google_maps_places
create table public.google_maps_places (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.google_maps_jobs(id) on delete cascade,
  query text,
  name text,
  category text,
  address text,
  phone text,
  website text,
  emails text[],
  linkedin_url text,
  google_maps_url text,
  place_id text,
  rating text,
  reviews_count integer,
  latitude double precision,
  longitude double precision,
  dedupe_key text not null,
  status text,
  created_at timestamptz not null default now()
);

create unique index idx_google_maps_places_job_dedupe
  on public.google_maps_places(job_id, dedupe_key);
create index idx_google_maps_places_job_id
  on public.google_maps_places(job_id);

-- google_news_jobs
create table public.google_news_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in (
    'queued','running','paused','stopped','completed','failed',
    'captcha','blocked','timeout','login_required'
  )),
  config jsonb not null default '{}'::jsonb,
  message text,
  total_targets integer not null default 0,
  processed_targets integer not null default 0,
  total_results integer not null default 0,
  proxy_enabled boolean not null default false,
  proxy_encrypted text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

create index idx_google_news_jobs_user_id_created_at
  on public.google_news_jobs(user_id, created_at desc);
create index idx_google_news_jobs_status
  on public.google_news_jobs(status)
  where status in ('queued', 'running');

-- google_news_results
create table public.google_news_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.google_news_jobs(id) on delete cascade,
  query text not null,
  position integer,
  title text,
  body text,
  posted text,
  source text,
  link text,
  created_at timestamptz not null default now()
);

create index idx_google_news_results_job_id
  on public.google_news_results(job_id);

-- RLS
alter table public.google_maps_jobs enable row level security;
alter table public.google_maps_places enable row level security;
alter table public.google_news_jobs enable row level security;
alter table public.google_news_results enable row level security;

create policy google_maps_jobs_own on public.google_maps_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy google_maps_places_own on public.google_maps_places
  for all using (
    exists (select 1 from public.google_maps_jobs j where j.id = job_id and j.user_id = auth.uid())
  );

create policy google_news_jobs_own on public.google_news_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy google_news_results_own on public.google_news_results
  for all using (
    exists (select 1 from public.google_news_jobs j where j.id = job_id and j.user_id = auth.uid())
  );
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260707_0001_create_google_parsers_tables.sql
git commit -m "feat(google-parsers): supabase schema for maps + news jobs and results"
```

---

## Phase 2 — Parser Service (`services/googleparsers/`)

### Task 2.1: Scaffold the service package

**Files:**
- Create: `services/googleparsers/package.json`
- Create: `services/googleparsers/tsconfig.json`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "portal-googleparsers",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/server.ts",
    "build": "tsc"
  },
  "dependencies": {
    "express": "^4.21.2",
    "playwright": "^1.49.1",
    "tsx": "^4.19.2",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.2",
    "@types/ws": "^8.5.13",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Commit**

```bash
git add services/googleparsers/package.json services/googleparsers/tsconfig.json
git commit -m "chore(google-parsers): scaffold services/googleparsers package"
```

### Task 2.2: Copy parser sources from external repo

**Files:**
- Create: `services/googleparsers/src/shared/types.ts`
- Create: `services/googleparsers/src/shared/googleMaps.ts`
- Create: `services/googleparsers/src/shared/googleNews.ts`
- Create: `services/googleparsers/src/shared/normalize.ts`
- Create: `services/googleparsers/src/shared/export.ts`
- Create: `services/googleparsers/src/parser/googleMapsParser.ts`
- Create: `services/googleparsers/src/parser/googleNewsParser.ts`
- Create: `services/googleparsers/src/parser/contactEnrichment.ts`

- [ ] **Step 1: Copy each source file 1-to-1**

From `G:\PycharmProjects\google-maps-news-parsers`, copy verbatim (no edits):

```bash
cp G:/PycharmProjects/google-maps-news-parsers/shared/types.ts       services/googleparsers/src/shared/types.ts
cp G:/PycharmProjects/google-maps-news-parsers/shared/googleMaps.ts  services/googleparsers/src/shared/googleMaps.ts
cp G:/PycharmProjects/google-maps-news-parsers/shared/googleNews.ts  services/googleparsers/src/shared/googleNews.ts
cp G:/PycharmProjects/google-maps-news-parsers/shared/normalize.ts   services/googleparsers/src/shared/normalize.ts
cp G:/PycharmProjects/google-maps-news-parsers/shared/export.ts      services/googleparsers/src/shared/export.ts
cp G:/PycharmProjects/google-maps-news-parsers/server/parser/googleMapsParser.ts   services/googleparsers/src/parser/googleMapsParser.ts
cp G:/PycharmProjects/google-maps-news-parsers/server/parser/googleNewsParser.ts   services/googleparsers/src/parser/googleNewsParser.ts
cp G:/PycharmProjects/google-maps-news-parsers/server/parser/contactEnrichment.ts  services/googleparsers/src/parser/contactEnrichment.ts
```

- [ ] **Step 2: Fix internal imports**

The copied files import from `../shared/*`. In the source repo, they lived at `server/parser/` and `shared/` so imports were `../../shared/*`. In our layout both are under `src/`, so the imports become `../shared/*`.

Run: `grep -n "from \"" services/googleparsers/src/parser/*.ts`

Expected: imports like `from "../../shared/types"`. Edit each to `from "../shared/types"`.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd services/googleparsers && npx tsc --noEmit
```

Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add services/googleparsers/src/shared services/googleparsers/src/parser
git commit -m "feat(google-parsers): import parser sources from jacob's standalone package"
```

### Task 2.3: Write the HTTP server

**Files:**
- Create: `services/googleparsers/src/server.ts`

- [ ] **Step 1: Write server.ts**

The service exposes two endpoints for the worker to call. Long-running jobs stream progress over Server-Sent Events (SSE) so the worker can persist partial results. The service holds ephemeral state (paused / stopped flags) in memory — durable state lives in Supabase.

```ts
import express from "express";
import { runGoogleMapsJob } from "./parser/googleMapsParser.js";
import { runGoogleNewsJob } from "./parser/googleNewsParser.js";
import type {
  NewsScrapeSettings,
  ScrapeSettings,
  ScrapeJob,
  NewsJob
} from "./shared/types.js";
import { generateSearchTargets } from "./shared/googleMaps.js";
import { generateNewsTargets } from "./shared/googleNews.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

const port = Number(process.env.PORT) || 8001;

type Control = { paused: boolean; stopped: boolean };
const controls = new Map<string, Control>();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/run/maps", async (req, res) => {
  const { jobId, settings } = req.body as { jobId: string; settings: ScrapeSettings };
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");

  const control: Control = { paused: false, stopped: false };
  controls.set(jobId, control);

  const targets = generateSearchTargets(settings);
  const job: ScrapeJob = {
    id: jobId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "running", settings, targets,
    currentTargetIndex: 0, processedPlaces: 0, totalDiscovered: 0,
    message: "", results: [], errors: []
  };

  const emit = (kind: string, payload: unknown) => {
    res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await runGoogleMapsJob(job, {
      onPlaceFound: (place) => emit("place", place),
      onProgress: (progress) => emit("progress", progress),
      onError: (error) => emit("error", error),
      shouldPause: () => control.paused,
      shouldStop: () => control.stopped
    });
    emit("done", { status: job.status, message: job.message });
  } catch (err) {
    emit("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    controls.delete(jobId);
    res.end();
  }
});

app.post("/run/news", async (req, res) => {
  const { jobId, settings } = req.body as { jobId: string; settings: NewsScrapeSettings };
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");

  const control: Control = { paused: false, stopped: false };
  controls.set(jobId, control);

  const targets = generateNewsTargets(settings);
  const job: NewsJob = {
    id: jobId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "running", settings, targets,
    currentTargetIndex: 0, processedPages: 0, totalRows: 0,
    message: "", results: [], errors: []
  };

  const emit = (kind: string, payload: unknown) => {
    res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await runGoogleNewsJob(job, {
      onResult: (result) => emit("result", result),
      onProgress: (progress) => emit("progress", progress),
      onError: (error) => emit("error", error),
      shouldPause: () => control.paused,
      shouldStop: () => control.stopped
    });
    emit("done", { status: job.status, message: job.message });
  } catch (err) {
    emit("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    controls.delete(jobId);
    res.end();
  }
});

app.post("/control/:jobId/:action", (req, res) => {
  const control = controls.get(req.params.jobId);
  if (!control) return res.status(404).json({ error: "job not running" });
  const action = req.params.action;
  if (action === "pause") control.paused = true;
  else if (action === "resume") control.paused = false;
  else if (action === "stop") control.stopped = true;
  else return res.status(400).json({ error: "unknown action" });
  return res.json({ ok: true });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`googleparsers service listening on :${port}`);
});
```

- [ ] **Step 2: Adjust parser modules to accept callbacks**

The source `googleMapsParser.ts` / `googleNewsParser.ts` today accept a `job` argument only. Modify their signatures to also accept a callbacks object matching the shape shown above.

Read: `services/googleparsers/src/parser/googleMapsParser.ts` and identify the `runGoogleMapsJob` export. It currently mutates `job.results.push(...)` and reads `job.status` for pause/stop.

Change signature from:

```ts
export async function runGoogleMapsJob(job: ScrapeJob): Promise<void>
```

to:

```ts
export interface MapsRunCallbacks {
  onPlaceFound: (place: PlaceResult) => void;
  onProgress: (progress: { currentTargetIndex: number; processedPlaces: number; totalDiscovered: number; message: string }) => void;
  onError: (error: JobError) => void;
  shouldPause: () => boolean;
  shouldStop: () => boolean;
}
export async function runGoogleMapsJob(job: ScrapeJob, cb: MapsRunCallbacks): Promise<void>
```

Inside, wherever the old code did `job.results.push(place)`, also call `cb.onPlaceFound(place)`. Wherever it checked internal pause/stop, call `cb.shouldPause()` / `cb.shouldStop()`. Same shape for `runGoogleNewsJob` with `MapsRunCallbacks` → `NewsRunCallbacks`, `onPlaceFound` → `onResult`.

- [ ] **Step 3: Verify TS compiles**

```bash
cd services/googleparsers && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add services/googleparsers/src/server.ts services/googleparsers/src/parser
git commit -m "feat(google-parsers): expose parser as SSE-streaming HTTP service"
```

### Task 2.4: Write the Dockerfile

**Files:**
- Create: `services/googleparsers/Dockerfile`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

# Install tsx as dev dep just for runtime (small, fast)
RUN npm install --no-save tsx

ENV NODE_ENV=production
EXPOSE 8001

CMD ["npx", "tsx", "src/server.ts"]
```

- [ ] **Step 2: Local build sanity check**

```bash
cd services/googleparsers && docker build -t portal-googleparsers:test .
```

Expected: image built successfully, no errors.

- [ ] **Step 3: Commit**

```bash
git add services/googleparsers/Dockerfile
git commit -m "chore(google-parsers): dockerfile for playwright service"
```

---

## Phase 3 — Portal Worker

### Task 3.1: Types

**Files:**
- Create: `app/src/types/googleParsers.ts`

- [ ] **Step 1: Write shared types**

```ts
// app/src/types/googleParsers.ts
export type GoogleParserStatus =
  | "queued" | "running" | "paused" | "stopped" | "completed" | "failed"
  | "captcha" | "blocked" | "timeout" | "login_required";

export interface GoogleMapsJobRow {
  id: string;
  user_id: string;
  status: GoogleParserStatus;
  config: {
    inputLines: string[];
    limitPerQuery: number;
    language: string;
    region: string;
    minDelayMs: number;
    maxDelayMs: number;
    enrichContacts: boolean;
  };
  message: string | null;
  total_targets: number;
  processed_targets: number;
  total_results: number;
  proxy_enabled: boolean;
  proxy_encrypted: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface GoogleMapsPlaceRow {
  id: string;
  job_id: string;
  query: string | null;
  name: string | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  emails: string[] | null;
  linkedin_url: string | null;
  google_maps_url: string | null;
  place_id: string | null;
  rating: string | null;
  reviews_count: number | null;
  latitude: number | null;
  longitude: number | null;
  dedupe_key: string;
  status: string | null;
  created_at: string;
}

export interface GoogleNewsJobRow {
  id: string;
  user_id: string;
  status: GoogleParserStatus;
  config: {
    queries: string[];
    pagesLimit: number;
    country: string;
    language: string;
    dateRange: "any" | "hour" | "day" | "week" | "month" | "year";
    minDelayMs: number;
    maxDelayMs: number;
  };
  message: string | null;
  total_targets: number;
  processed_targets: number;
  total_results: number;
  proxy_enabled: boolean;
  proxy_encrypted: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface GoogleNewsResultRow {
  id: string;
  job_id: string;
  query: string;
  position: number | null;
  title: string | null;
  body: string | null;
  posted: string | null;
  source: string | null;
  link: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/types/googleParsers.ts
git commit -m "feat(google-parsers): row + config types"
```

Note: proxy encryption reuses `encryptJsonAes256Gcm(proxies, key)` and `decryptJsonAes256Gcm<string[]>(sealed, key)` from `app/src/lib/cryptoGcm.ts` — no new cipher module needed.

### Task 3.2: Worker business logic

**Files:**
- Create: `app/lib/parsers/googleParsersWorker.ts`
- Create: `app/tests/lib/parsers/googleParsersWorker.test.ts`

- [ ] **Step 1: Write worker test (dedupe key + row mapping)**

```ts
// app/tests/lib/parsers/googleParsersWorker.test.ts
import { describe, expect, test } from "vitest";
import { placeResultToRow, newsResultToRow } from "@/../lib/parsers/googleParsersWorker";

describe("placeResultToRow", () => {
  test("maps parser PlaceResult to google_maps_places row shape", () => {
    const row = placeResultToRow("job-1", {
      query: "cafes Berlin", city: "", category: "cafe",
      name: "Cafe X", address: "1 Str, Berlin", phone: "+49 123",
      website: "https://cafex.de", emails: ["hi@cafex.de"], socials: [],
      linkedInUrl: "https://linkedin.com/company/cafex",
      rating: "4.5", reviewsCount: "128",
      googleMapsUrl: "https://maps.google.com/?cid=1", placeId: "cid:1",
      googleId: "gid:1", latitude: "52.5", longitude: "13.4",
      dedupeKey: "cid:1", sourceUrl: "cafes Berlin", status: "ok"
    });
    expect(row.job_id).toBe("job-1");
    expect(row.name).toBe("Cafe X");
    expect(row.emails).toEqual(["hi@cafex.de"]);
    expect(row.reviews_count).toBe(128);
    expect(row.latitude).toBe(52.5);
    expect(row.dedupe_key).toBe("cid:1");
  });

  test("empty reviews_count → null (not zero)", () => {
    const row = placeResultToRow("job-1", {
      query: "", city: "", category: "", name: "", address: "", phone: "",
      website: "", emails: [], socials: [], linkedInUrl: "",
      rating: "", reviewsCount: "", googleMapsUrl: "", placeId: "",
      googleId: "", latitude: "", longitude: "",
      dedupeKey: "abc", sourceUrl: "", status: "partial"
    });
    expect(row.reviews_count).toBeNull();
    expect(row.latitude).toBeNull();
  });
});

describe("newsResultToRow", () => {
  test("maps NewsResult to google_news_results row", () => {
    const row = newsResultToRow("job-2", {
      query: "AI news", position: 3, title: "Big AI update",
      body: "Body text", posted: "2h ago", source: "TechNews",
      link: "https://techn.com/x"
    });
    expect(row.job_id).toBe("job-2");
    expect(row.position).toBe(3);
    expect(row.link).toBe("https://techn.com/x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && npx vitest run tests/lib/parsers/googleParsersWorker.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write worker implementation**

```ts
// app/lib/parsers/googleParsersWorker.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { decryptJsonAes256Gcm } from "@/lib/cryptoGcm";
import type { GoogleMapsJobRow, GoogleNewsJobRow, GoogleMapsPlaceRow, GoogleNewsResultRow, GoogleParserStatus } from "@/types/googleParsers";

const SERVICE_URL = process.env.GOOGLEPARSERS_SERVICE_URL ?? "http://googleparsers:8001";
const PROXY_KEY = process.env.GOOGLEPARSERS_PROXY_ENCRYPTION_KEY ?? "";

// Parser types mirror the ones in services/googleparsers/src/shared/types.ts
type ParserPlace = {
  query: string; city: string; category: string; name: string; address: string;
  phone: string; website: string; emails: string[]; socials: string[]; linkedInUrl: string;
  rating: string; reviewsCount: string; googleMapsUrl: string; placeId: string; googleId: string;
  latitude: string; longitude: string; dedupeKey: string; sourceUrl: string; status: string;
};
type ParserNews = {
  query: string; position: number; title: string; body: string; posted: string;
  source: string; link: string;
};

export function placeResultToRow(jobId: string, p: ParserPlace): Omit<GoogleMapsPlaceRow, "id" | "created_at"> {
  return {
    job_id: jobId,
    query: p.query || null,
    name: p.name || null,
    category: p.category || null,
    address: p.address || null,
    phone: p.phone || null,
    website: p.website || null,
    emails: p.emails.length ? p.emails : null,
    linkedin_url: p.linkedInUrl || null,
    google_maps_url: p.googleMapsUrl || null,
    place_id: p.placeId || null,
    rating: p.rating || null,
    reviews_count: p.reviewsCount ? Number(p.reviewsCount) : null,
    latitude: p.latitude ? Number(p.latitude) : null,
    longitude: p.longitude ? Number(p.longitude) : null,
    dedupe_key: p.dedupeKey,
    status: p.status || null
  };
}

export function newsResultToRow(jobId: string, n: ParserNews): Omit<GoogleNewsResultRow, "id" | "created_at"> {
  return {
    job_id: jobId,
    query: n.query,
    position: n.position ?? null,
    title: n.title || null,
    body: n.body || null,
    posted: n.posted || null,
    source: n.source || null,
    link: n.link || null
  };
}

async function updateMapsJob(jobId: string, patch: Partial<GoogleMapsJobRow>) {
  const db = supabaseAdmin();
  const { error } = await db.from("google_maps_jobs").update(patch).eq("id", jobId);
  if (error) throw error;
}

async function updateNewsJob(jobId: string, patch: Partial<GoogleNewsJobRow>) {
  const db = supabaseAdmin();
  const { error } = await db.from("google_news_jobs").update(patch).eq("id", jobId);
  if (error) throw error;
}

async function checkControlSignal(table: "google_maps_jobs" | "google_news_jobs", jobId: string):
    Promise<{ pause: boolean; stop: boolean }> {
  const db = supabaseAdmin();
  const { data } = await db.from(table).select("status").eq("id", jobId).maybeSingle();
  return { pause: data?.status === "paused", stop: data?.status === "stopped" };
}

async function streamSse(url: string, body: unknown, handlers: Record<string, (data: unknown) => Promise<void> | void>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.body) throw new Error("service returned empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const chunk of parts) {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
      const dataLine = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "";
      if (!dataLine) continue;
      const handler = handlers[event];
      if (handler) await handler(JSON.parse(dataLine));
    }
  }
}

export async function runGoogleMapsJob(jobId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: job } = await db.from("google_maps_jobs").select("*").eq("id", jobId).single<GoogleMapsJobRow>();
  if (!job) throw new Error(`job ${jobId} not found`);

  const proxies = job.proxy_enabled && job.proxy_encrypted
    ? decryptJsonAes256Gcm<string[]>(job.proxy_encrypted, PROXY_KEY)
    : [];

  const settings = { ...job.config, cities: [], categories: [], keyword: "", proxies };

  const placeBatch: ReturnType<typeof placeResultToRow>[] = [];
  const flush = async () => {
    if (!placeBatch.length) return;
    const rows = placeBatch.splice(0);
    await db.from("google_maps_places").upsert(rows, { onConflict: "job_id,dedupe_key", ignoreDuplicates: true });
    await updateMapsJob(jobId, { total_results: (await countRows("google_maps_places", jobId)) });
  };

  let finalStatus: GoogleParserStatus = "completed";
  let finalMessage = "";

  await streamSse(`${SERVICE_URL}/run/maps`, { jobId, settings }, {
    place: async (data) => {
      placeBatch.push(placeResultToRow(jobId, data as ParserPlace));
      if (placeBatch.length >= 20) await flush();
    },
    progress: async (data) => {
      const p = data as { currentTargetIndex: number; processedPlaces: number; totalDiscovered: number; message: string };
      await updateMapsJob(jobId, {
        processed_targets: p.currentTargetIndex,
        message: p.message
      });
      const sig = await checkControlSignal("google_maps_jobs", jobId);
      if (sig.stop) {
        finalStatus = "stopped";
        await fetch(`${SERVICE_URL}/control/${jobId}/stop`, { method: "POST" });
      } else if (sig.pause) {
        await fetch(`${SERVICE_URL}/control/${jobId}/pause`, { method: "POST" });
      }
    },
    error: async (data) => {
      const e = data as { message: string };
      finalMessage = e.message;
    },
    done: async (data) => {
      const d = data as { status: GoogleParserStatus; message: string };
      finalStatus = d.status;
      finalMessage = d.message || finalMessage;
    }
  });

  await flush();
  await updateMapsJob(jobId, {
    status: finalStatus,
    message: finalMessage,
    completed_at: new Date().toISOString()
  });
}

export async function runGoogleNewsJob(jobId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: job } = await db.from("google_news_jobs").select("*").eq("id", jobId).single<GoogleNewsJobRow>();
  if (!job) throw new Error(`job ${jobId} not found`);

  const proxies = job.proxy_enabled && job.proxy_encrypted
    ? decryptJsonAes256Gcm<string[]>(job.proxy_encrypted, PROXY_KEY)
    : [];

  const settings = { ...job.config, proxies };

  const batch: ReturnType<typeof newsResultToRow>[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = batch.splice(0);
    await db.from("google_news_results").insert(rows);
    await updateNewsJob(jobId, { total_results: await countRows("google_news_results", jobId) });
  };

  let finalStatus: GoogleParserStatus = "completed";
  let finalMessage = "";

  await streamSse(`${SERVICE_URL}/run/news`, { jobId, settings }, {
    result: async (data) => {
      batch.push(newsResultToRow(jobId, data as ParserNews));
      if (batch.length >= 20) await flush();
    },
    progress: async (data) => {
      const p = data as { currentTargetIndex: number; message: string };
      await updateNewsJob(jobId, { processed_targets: p.currentTargetIndex, message: p.message });
      const sig = await checkControlSignal("google_news_jobs", jobId);
      if (sig.stop) {
        finalStatus = "stopped";
        await fetch(`${SERVICE_URL}/control/${jobId}/stop`, { method: "POST" });
      } else if (sig.pause) {
        await fetch(`${SERVICE_URL}/control/${jobId}/pause`, { method: "POST" });
      }
    },
    error: async (data) => {
      const e = data as { message: string };
      finalMessage = e.message;
    },
    done: async (data) => {
      const d = data as { status: GoogleParserStatus; message: string };
      finalStatus = d.status;
      finalMessage = d.message || finalMessage;
    }
  });

  await flush();
  await updateNewsJob(jobId, {
    status: finalStatus,
    message: finalMessage,
    completed_at: new Date().toISOString()
  });
}

async function countRows(table: string, jobId: string): Promise<number> {
  const db = supabaseAdmin();
  const { count } = await db.from(table).select("id", { count: "exact", head: true }).eq("job_id", jobId);
  return count ?? 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd app && npx vitest run tests/lib/parsers/googleParsersWorker.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/parsers/googleParsersWorker.ts app/tests/lib/parsers/googleParsersWorker.test.ts
git commit -m "feat(google-parsers): worker business logic — SSE stream + Supabase persistence"
```

### Task 3.3: Worker docker entrypoint

**Files:**
- Create: `app/worker/googleparsers.ts`
- Modify: `app/worker/runner.ts:88` (add case)
- Modify: `Dockerfile.worker:43` (add to esbuild list)

- [ ] **Step 1: Write worker entrypoint**

```ts
// app/worker/googleparsers.ts
import { runGoogleMapsJob, runGoogleNewsJob } from "@/../lib/parsers/googleParsersWorker";
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from "./_shared";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? "5000");
const MAX_CONCURRENCY = Number(process.env.GOOGLEPARSERS_CONCURRENCY ?? "1");
const WORKER_ID = `googleparsers-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);
const running = new Set<Promise<void>>();

async function startupRecovery(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  for (const table of ["google_maps_jobs", "google_news_jobs"] as const) {
    const { data, error } = await db.from(table).update({ status: "queued" }).eq("status", "running").select("id");
    if (error) log("warn", `Startup recovery: ${table} update failed`, error);
    else if (data?.length) log("info", `Startup recovery: reset ${data.length} rows in ${table} to queued`);
  }
}

type Claim = { id: string; kind: "maps" | "news" };

async function claim(): Promise<Claim | null> {
  const db = requireSupabaseAdmin(log);
  for (const [table, kind] of [["google_maps_jobs", "maps"], ["google_news_jobs", "news"]] as const) {
    const { data: pending } = await db.from(table).select("id")
      .eq("status", "queued").order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (!pending) continue;
    const { data: claimed } = await db.from(table)
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", pending.id).eq("status", "queued")
      .select("id").maybeSingle();
    if (claimed) return { id: claimed.id as string, kind };
  }
  return null;
}

async function pollOnce(): Promise<boolean> {
  if (running.size >= MAX_CONCURRENCY) { await sleep(500); return true; }
  const job = await claim();
  if (!job) return false;
  const task = (async () => {
    try {
      if (job.kind === "maps") await runGoogleMapsJob(job.id);
      else await runGoogleNewsJob(job.id);
    } catch (err) {
      log("error", `Job ${job.id} (${job.kind}) crashed`, err);
      const db = requireSupabaseAdmin(log);
      await db.from(job.kind === "maps" ? "google_maps_jobs" : "google_news_jobs")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", job.id);
    }
  })();
  running.add(task);
  void task.finally(() => running.delete(task));
  return true;
}

async function main(): Promise<void> {
  log("info", `Starting GoogleParsers worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);
  await startupRecovery();
  await pollLoop({ log, pollIntervalMs: POLL_INTERVAL_MS, shouldStop, pollOnce, realtimeTables: ["google_maps_jobs", "google_news_jobs"] });
}

main().catch((err) => { log("error", "Worker crashed", err); process.exit(1); });
```

- [ ] **Step 2: Register in runner.ts**

Read `app/worker/runner.ts:84-88`. Add before `case 'all':`:

```ts
case 'googleparsers':
case 'google-parsers':
  run('./googleparsers');
  break;
```

- [ ] **Step 3: Register in Dockerfile.worker**

Read `Dockerfile.worker:43`. Locate the long list of `worker/*.ts` files passed to `esbuild`. Append `worker/googleparsers.ts` to the list (before the closing `\`).

- [ ] **Step 4: Type-check worker**

```bash
cd app && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/worker/googleparsers.ts app/worker/runner.ts Dockerfile.worker
git commit -m "feat(google-parsers): worker entrypoint + register in runner and Dockerfile"
```

---

## Phase 4 — Next.js API Routes

Each route mirrors `app/src/app/api/parsers/yandexmaps/`. Actual portal auth pattern (from `yandexmaps/route.ts:14-22`):

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);
  // ... use `supabase` for reads (respects RLS) or `supabaseAdmin()` for writes
}
```

All routes below follow this exact template — replace the generic `getServerUser()` scaffolding in the code samples with the block above.

Proxy encryption uses `encryptJsonAes256Gcm(proxies, key)` / `decryptJsonAes256Gcm<string[]>(sealed, key)` from `@/lib/cryptoGcm` (existing).

### Task 4.1: Create + list route (Maps)

**Files:**
- Create: `app/src/app/api/parsers/googlemaps/route.ts`

- [ ] **Step 1: Read yandex maps reference**

```bash
cat app/src/app/api/parsers/yandexmaps/route.ts
```

Observe: how the POST validates settings, computes `total_targets`, encrypts proxies, inserts row, returns `{ job }`.

- [ ] **Step 2: Write route.ts**

```ts
// app/src/app/api/parsers/googlemaps/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAuthedSupabaseClient, getBearerToken } from "@/lib/supabaseRouteClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { encryptProxies } from "@/lib/parsers/googleParsersProxyCipher";

const PROXY_KEY = process.env.GOOGLEPARSERS_PROXY_ENCRYPTION_KEY ?? "";

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data, error } = await db.from("google_maps_jobs").select("*")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const {
    inputLines = [], limitPerQuery = 100, language = "ru", region = "RU",
    minDelayMs = 1200, maxDelayMs = 2800, enrichContacts = true,
    proxies = []
  } = body as Record<string, unknown>;
  const inputArr = Array.isArray(inputLines) ? (inputLines as string[]).filter(Boolean) : [];
  if (inputArr.length === 0) {
    return NextResponse.json({ error: "inputLines is required and must be non-empty" }, { status: 400 });
  }
  const proxyArr = Array.isArray(proxies) ? (proxies as string[]).filter(Boolean) : [];
  const config = { inputLines: inputArr, limitPerQuery, language, region, minDelayMs, maxDelayMs, enrichContacts };
  const db = supabaseAdmin();
  const { data, error } = await db.from("google_maps_jobs").insert({
    user_id: user.id,
    status: "queued",
    config,
    total_targets: inputArr.length,
    proxy_enabled: proxyArr.length > 0,
    proxy_encrypted: proxyArr.length ? encryptProxies(proxyArr, PROXY_KEY) : null
  }).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: data }, { status: 201 });
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/parsers/googlemaps/route.ts
git commit -m "feat(google-parsers): api create+list route for maps jobs"
```

### Task 4.2: Get + control routes (Maps)

**Files:**
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/pause/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/resume/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/stop/route.ts`

- [ ] **Step 1: Write GET one**

```ts
// app/src/app/api/parsers/googlemaps/[jobId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAuthedSupabaseClient, getBearerToken } from "@/lib/supabaseRouteClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  const token = getBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data, error } = await db.from("google_maps_jobs")
    .select("*").eq("id", params.jobId).eq("user_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ job: data });
}
```

- [ ] **Step 2: Write control routes (pause / resume / stop)**

All three share the same structure. Create each with the appropriate status transition:

```ts
// app/src/app/api/parsers/googlemaps/[jobId]/pause/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAuthedSupabaseClient, getBearerToken } from "@/lib/supabaseRouteClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  const token = getBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const { data, error } = await db.from("google_maps_jobs")
    .update({ status: "paused" })
    .eq("id", params.jobId).eq("user_id", user.id).in("status", ["running", "queued"])
    .select("*").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "cannot pause in current state" }, { status: 409 });
  return NextResponse.json({ job: data });
}
```

For resume: allowed statuses `["paused"]`, new status `"running"` (worker picks it up on next poll — but simpler: keep as `"queued"` so worker's claim query picks it). Use `"queued"` in the `update` payload.

For stop: allowed statuses `["running", "queued", "paused"]`, new status `"stopped"`.

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/parsers/googlemaps/[jobId]
git commit -m "feat(google-parsers): api get + pause/resume/stop routes for maps"
```

### Task 4.3: Results, export, queue-status routes (Maps)

**Files:**
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/results/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/[jobId]/export/route.ts`
- Create: `app/src/app/api/parsers/googlemaps/queue-status/route.ts`

- [ ] **Step 1: Write results (paginated)**

```ts
// app/src/app/api/parsers/googlemaps/[jobId]/results/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAuthedSupabaseClient, getBearerToken } from "@/lib/supabaseRouteClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  const token = getBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "5000"), 5000);
  const offset = Math.max(Number(req.nextUrl.searchParams.get("offset") ?? "0"), 0);
  const db = supabaseAdmin();
  const { data: job } = await db.from("google_maps_jobs")
    .select("id").eq("id", params.jobId).eq("user_id", user.id).maybeSingle();
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data, error } = await db.from("google_maps_places")
    .select("*").eq("job_id", params.jobId).order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data ?? [], hasMore: (data?.length ?? 0) === limit });
}
```

- [ ] **Step 2: Write export (CSV / JSON via ?format=)**

```ts
// app/src/app/api/parsers/googlemaps/[jobId]/export/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAuthedSupabaseClient, getBearerToken } from "@/lib/supabaseRouteClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { toCsv } from "../../../../../../../services/googleparsers/src/shared/export";
// TS-only import — Next.js won't bundle it at runtime because we ship a pure fn.
// If path traversal is unacceptable, duplicate the toCsv fn into app/src/lib/parsers/googleParsersExport.ts.

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  const token = getBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const format = req.nextUrl.searchParams.get("format") ?? "csv";
  const db = supabaseAdmin();
  const { data: job } = await db.from("google_maps_jobs")
    .select("id").eq("id", params.jobId).eq("user_id", user.id).maybeSingle();
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: rows, error } = await db.from("google_maps_places").select("*")
    .eq("job_id", params.jobId).order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (format === "json") {
    return new NextResponse(JSON.stringify(rows ?? []), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="google-maps-${params.jobId}.json"`
      }
    });
  }

  // CSV: reconstruct a PlaceResult from the row, then delegate to toCsv
  const places = (rows ?? []).map((r) => ({
    query: r.query ?? "", city: "", category: r.category ?? "",
    name: r.name ?? "", address: r.address ?? "", phone: r.phone ?? "",
    website: r.website ?? "", emails: r.emails ?? [], socials: [],
    linkedInUrl: r.linkedin_url ?? "",
    rating: r.rating ?? "", reviewsCount: r.reviews_count ? String(r.reviews_count) : "",
    googleMapsUrl: r.google_maps_url ?? "", placeId: r.place_id ?? "", googleId: "",
    latitude: r.latitude ? String(r.latitude) : "", longitude: r.longitude ? String(r.longitude) : "",
    dedupeKey: r.dedupe_key, sourceUrl: r.query ?? "",
    status: (r.status as "ok" | "partial" | "captcha" | "blocked" | "timeout" | "error") ?? "ok"
  }));
  const csv = "﻿" + toCsv(places);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="google-maps-${params.jobId}.csv"`
    }
  });
}
```

**Note:** if the path traversal import above triggers TS-config issues, duplicate `toCsv` into `app/src/lib/parsers/googleParsersExport.ts` (~30 lines) and import from there.

- [ ] **Step 3: Write queue-status**

```ts
// app/src/app/api/parsers/googlemaps/queue-status/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { createAuthedSupabaseClient, getBearerToken } from "@/lib/supabaseRouteClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type QueueStatusResponse = {
  activeJobId: string | null;
  queuedCount: number;
  averageJobDurationSec: number;
};

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const [{ data: active }, { count: queued }, { data: recent }] = await Promise.all([
    db.from("google_maps_jobs").select("id").eq("status", "running").order("started_at", { ascending: true }).limit(1).maybeSingle(),
    db.from("google_maps_jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
    db.from("google_maps_jobs").select("started_at,completed_at").eq("status", "completed")
      .gte("completed_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).limit(50)
  ]);
  const durations = (recent ?? [])
    .map((r) => r.started_at && r.completed_at ? (new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000 : null)
    .filter((n): n is number => n != null && n > 0);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const response: QueueStatusResponse = { activeJobId: active?.id ?? null, queuedCount: queued ?? 0, averageJobDurationSec: avg };
  return NextResponse.json(response);
}
```

- [ ] **Step 4: Commit**

```bash
git add app/src/app/api/parsers/googlemaps
git commit -m "feat(google-parsers): api results/export/queue-status for maps"
```

### Task 4.4: Mirror all Maps routes for News

**Files:**
- Create: `app/src/app/api/parsers/googlenews/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/pause/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/resume/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/stop/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/results/route.ts`
- Create: `app/src/app/api/parsers/googlenews/[jobId]/export/route.ts`
- Create: `app/src/app/api/parsers/googlenews/queue-status/route.ts`

- [ ] **Step 1: For each Maps route above, create the News mirror**

Substitution rules from Maps→News:

| Maps | News |
|---|---|
| `google_maps_jobs`     | `google_news_jobs` |
| `google_maps_places`   | `google_news_results` |
| `inputLines`           | `queries` |
| `limitPerQuery`        | `pagesLimit` |
| `language, region, enrichContacts` | `country, language, dateRange` |
| `toCsv(places)` from `services/googleparsers/src/shared/export` | `newsToCsv(results)` from same module |
| `googlemaps` in URLs   | `googlenews` |
| `google-maps-` in filenames | `google-news-` |

Row shape: use `GoogleNewsJobRow` / `GoogleNewsResultRow` from `app/src/types/googleParsers.ts`.

For CSV export, reconstruct `NewsResult` from row:

```ts
const results = (rows ?? []).map((r) => ({
  query: r.query, position: r.position ?? 0, title: r.title ?? "",
  body: r.body ?? "", posted: r.posted ?? "", source: r.source ?? "", link: r.link ?? ""
}));
```

Config validation for News create:

```ts
const {
  queries = [], pagesLimit = 3, country = "US", language = "en", dateRange = "any",
  minDelayMs = 1200, maxDelayMs = 2800, proxies = []
} = body as Record<string, unknown>;
const queryArr = Array.isArray(queries) ? (queries as string[]).filter(Boolean) : [];
if (queryArr.length === 0) return NextResponse.json({ error: "queries is required and must be non-empty" }, { status: 400 });
const config = { queries: queryArr, pagesLimit, country, language, dateRange, minDelayMs, maxDelayMs };
// total_targets = queries.length * pagesLimit  ← unlike Maps, News expands by pages
```

- [ ] **Step 2: Commit each subgroup as it's created (three commits total)**

```bash
# after route.ts + [jobId]/route.ts
git add app/src/app/api/parsers/googlenews/route.ts app/src/app/api/parsers/googlenews/\[jobId\]/route.ts
git commit -m "feat(google-parsers): api create+list+get routes for news jobs"

# after pause/resume/stop
git add app/src/app/api/parsers/googlenews/\[jobId\]/pause app/src/app/api/parsers/googlenews/\[jobId\]/resume app/src/app/api/parsers/googlenews/\[jobId\]/stop
git commit -m "feat(google-parsers): api pause/resume/stop for news jobs"

# after results/export/queue-status
git add app/src/app/api/parsers/googlenews/\[jobId\]/results app/src/app/api/parsers/googlenews/\[jobId\]/export app/src/app/api/parsers/googlenews/queue-status
git commit -m "feat(google-parsers): api results/export/queue-status for news"
```

---

## Phase 5 — Portal UI

### Task 5.1: Google Maps view + form

**Files:**
- Create: `app/src/components/parsers/GoogleMapsParserView.tsx`
- Create: `app/src/components/parsers/GoogleMapsParserForm.tsx`

- [ ] **Step 1: Read yandex maps view + form as reference**

```bash
head -250 app/src/components/parsers/YandexMapsParserView.tsx
head -250 app/src/components/parsers/YandexMapsParserForm.tsx
```

Note the shape: props, hooks, refresh cycle, control handlers, "Add to /tools/databases" button, ClientTariffUsageInline placement.

- [ ] **Step 2: Write GoogleMapsParserForm.tsx**

Model after `YandexMapsParserForm` — a controlled form component that renders:
- Textarea for `inputLines` (labeled "URL или поисковые запросы, по строке")
- Number inputs: `limitPerQuery` (1-100), `minDelayMs` (300-30000), `maxDelayMs`
- Text inputs: `language` (default "ru"), `region` (default "RU")
- Checkbox: `enrichContacts` (labeled "Искать email, LinkedIn и соцсети на сайте")
- Textarea for `proxies` (one per line, placeholder `http://user:pass@host:port`)
- Emits an `onSubmit(config)` where `config` matches `GoogleMapsJobRow['config']` + `{ proxies: string[] }`.

Structure follows `YandexMapsParserForm.tsx`. Use `formatBusinessInput` conventions from portal Tailwind style.

- [ ] **Step 3: Write GoogleMapsParserView.tsx**

Structure — copy `YandexMapsParserView.tsx` wholesale, then substitute:

| Yandex | Google Maps |
|---|---|
| `yandex_maps_jobs` (any supabase.from() usage) | `google_maps_jobs` |
| `/api/parsers/yandexmaps` | `/api/parsers/googlemaps` |
| `YandexMapsJob`, `YandexMapsOrganizationRow` types | `GoogleMapsJobRow`, `GoogleMapsPlaceRow` |
| `YandexMapsParserForm` | `GoogleMapsParserForm` |
| `MapPin` icon from lucide | `MapPinned` |
| Column set in results table | Компания · Адрес · Телефон · Сайт · LinkedIn · Email · Рейтинг · Статус |
| "Yandex Maps" title | "Google Maps" |

For the "Add to /tools/databases" button, follow `CrunchbaseParserView.tsx:232` pattern:

```ts
const rows = places.map((p) => [
  p.name ?? "", p.phone ?? "", p.website ?? "",
  (p.emails?.[0] ?? ""), p.linkedin_url ?? "", p.address ?? "", p.category ?? ""
]);
const headerRow = ["company", "phone", "website", "email", "linkedin", "address", "industry"];
const { id } = writePendingDbImport({ title: `Google Maps #${activeJobId.slice(0, 8)}`, rows: [headerRow, ...rows] });
setToast({ tone: "success", message: `Добавлено (${rows.length})`, href: buildDatabasesImportUrl(id) });
```

Poll interval on active job: 1800ms (matches original).

- [ ] **Step 4: Type-check**

```bash
cd app && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/parsers/GoogleMapsParserView.tsx app/src/components/parsers/GoogleMapsParserForm.tsx
git commit -m "feat(google-parsers): Maps UI view + form (Yandex Maps pattern)"
```

### Task 5.2: Google News view + form

**Files:**
- Create: `app/src/components/parsers/GoogleNewsParserView.tsx`
- Create: `app/src/components/parsers/GoogleNewsParserForm.tsx`

- [ ] **Step 1: Write GoogleNewsParserForm.tsx**

Fields:
- Textarea `queries` (labeled "Ключевые запросы, по строке")
- Number `pagesLimit` (1-10)
- Text `country` (default "US"), `language` (default "en")
- Select `dateRange` with options: `any` "Любое время" · `hour` · `day` · `week` · `month` · `year` (Russian labels)
- Number `minDelayMs`, `maxDelayMs`
- Textarea `proxies`

Emits `onSubmit(config)` matching `GoogleNewsJobRow['config']` + `{ proxies }`.

- [ ] **Step 2: Write GoogleNewsParserView.tsx**

Same shape as GoogleMapsParserView with substitutions:

| Google Maps | Google News |
|---|---|
| `google_maps_jobs` / `google_maps_places` | `google_news_jobs` / `google_news_results` |
| `/api/parsers/googlemaps` | `/api/parsers/googlenews` |
| Columns: Компания · Адрес · Телефон · Сайт · LinkedIn · Email · Рейтинг · Статус | Query · Position · Title · Body · Posted · Source · Link |
| "Добавить в /tools/databases" button | (remove — News isn't leads) |
| `MapPinned` icon | `Newspaper` icon |
| "Google Maps" title | "Google News" |

- [ ] **Step 3: Type-check**

```bash
cd app && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/parsers/GoogleNewsParserView.tsx app/src/components/parsers/GoogleNewsParserForm.tsx
git commit -m "feat(google-parsers): News UI view + form"
```

### Task 5.3: Register tabs in /parsers page

**Files:**
- Modify: `app/src/app/parsers/page.tsx`

- [ ] **Step 1: Read the current page**

```bash
head -100 app/src/app/parsers/page.tsx
```

Note the `Tab` union type on line 16 and the tabs render section.

- [ ] **Step 2: Add imports at top**

```ts
import { GoogleMapsParserView } from '@/components/parsers/GoogleMapsParserView';
import { GoogleNewsParserView } from '@/components/parsers/GoogleNewsParserView';
```

- [ ] **Step 3: Extend the Tab union**

Change:

```ts
type Tab = 'hh' | 'eng-hiring' | 'ats' | 'crunchbase' | 'eu-us-base' | 'hh-archive' | 'search' | 'yandexmaps' | 'yandexdirect' | 'crypto';
```

to:

```ts
type Tab = 'hh' | 'eng-hiring' | 'ats' | 'crunchbase' | 'eu-us-base' | 'hh-archive' | 'search' | 'yandexmaps' | 'yandexdirect' | 'crypto' | 'googlemaps' | 'googlenews';
```

- [ ] **Step 4: Add two tab buttons**

After the last existing tab button (find `crypto`), insert two buttons matching the existing pattern (whitespace-nowrap, border-b-2, active state colors). Use text "Google Maps" and "Google News".

- [ ] **Step 5: Add two tab content branches**

Wherever the current file conditionally renders `<YandexMapsParserView />`, add analogous branches:

```tsx
{activeTab === 'googlemaps' && <GoogleMapsParserView />}
{activeTab === 'googlenews' && <GoogleNewsParserView />}
```

- [ ] **Step 6: Type-check**

```bash
cd app && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add app/src/app/parsers/page.tsx
git commit -m "feat(google-parsers): register Google Maps + News tabs on /parsers"
```

---

## Phase 6 — Docker Compose

### Task 6.1: Extend docker-compose.prod.yml and docker-compose.yml

**Files:**
- Modify: `docker-compose.prod.yml`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Read prod compose to find yandexmaps + worker-yandexmaps blocks**

```bash
grep -n "worker-yandexmaps\|yandexmaps:" docker-compose.prod.yml
```

- [ ] **Step 2: Add googleparsers service block**

Insert after `yandexmaps:` block (near line 767):

```yaml
googleparsers:
  image: ${DOCKER_USERNAME}/portal-googleparsers:prod
  container_name: portal-googleparsers
  restart: unless-stopped
  networks:
    - portal-net
```

- [ ] **Step 3: Add worker-googleparsers block**

Insert after `worker-yandexmaps:` block (near line 274):

```yaml
worker-googleparsers:
  image: ${DOCKER_USERNAME}/portal-worker:prod
  container_name: portal-worker-googleparsers
  restart: unless-stopped
  environment:
    - WORKER_KIND=googleparsers
    - GOOGLEPARSERS_SERVICE_URL=http://googleparsers:8001
    - GOOGLEPARSERS_CONCURRENCY=1
    - GOOGLEPARSERS_PROXY_ENCRYPTION_KEY=${GOOGLEPARSERS_PROXY_ENCRYPTION_KEY}
    - SUPABASE_URL=${SUPABASE_URL}
    - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
  depends_on:
    - googleparsers
  networks:
    - portal-net
```

- [ ] **Step 4: Add env vars to app service**

Find the `app:` service block. In its `environment:` section, add:

```yaml
- GOOGLEPARSERS_SERVICE_URL=http://googleparsers:8001
- GOOGLEPARSERS_PROXY_ENCRYPTION_KEY=${GOOGLEPARSERS_PROXY_ENCRYPTION_KEY}
```

- [ ] **Step 5: Add app dependency**

In the `app:` service `depends_on:` list (currently includes `yandexmaps`), add `googleparsers`.

- [ ] **Step 6: Mirror all changes to docker-compose.yml (local dev)**

Same additions, but `image:` for `googleparsers` uses `build:` context instead:

```yaml
googleparsers:
  build:
    context: ./services/googleparsers
    dockerfile: Dockerfile
  container_name: portal-googleparsers-dev
  restart: unless-stopped
  networks:
    - portal-net
```

- [ ] **Step 7: Compose lint**

```bash
docker compose -f docker-compose.prod.yml config > /dev/null
docker compose -f docker-compose.yml config > /dev/null
```

Expected: exit 0 for both.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.prod.yml docker-compose.yml
git commit -m "feat(google-parsers): add googleparsers service and worker to docker-compose"
```

---

## Phase 7 — Smoke Test + PR

### Task 7.1: Local smoke test

- [ ] **Step 1: Bring stack up locally**

```bash
docker compose up -d --build googleparsers worker-googleparsers app
```

Expected: all three containers running.

- [ ] **Step 2: Verify service health**

```bash
docker compose exec app curl -s http://googleparsers:8001/health
```

Expected: `{"ok":true}`.

- [ ] **Step 3: Manual UI smoke test**

1. Open `http://localhost:3000/parsers` (or your dev port).
2. Switch to "Google Maps" tab.
3. Enter one query: `cafe berlin`, limit `5`.
4. Click "Запустить".
5. Wait ~30-60 sec. Progress should tick up.
6. Verify 3-5 places appear in results table with name/address/phone/website.
7. Click "Скачать CSV" — file downloads, opens in Excel, columns match `title,placeUrl,website,status,email,rating,reviewCount,category,address,linkedInUrl,phoneNumber,searchQuery`.
8. Click "Добавить в /tools/databases" — redirects with pre-filled rows.
9. Switch to "Google News" tab.
10. Enter one query: `AI regulation`, pages `1`.
11. Click "Запустить", verify ~10 rows land, CSV downloads in Outscraper format.

- [ ] **Step 4: Verify database rows**

```bash
docker compose exec db psql -U postgres -d portal -c "select id, status, total_results from google_maps_jobs order by created_at desc limit 3;"
docker compose exec db psql -U postgres -d portal -c "select count(*) from google_maps_places;"
```

Expected: recent job has `status='completed'` and non-zero `total_results`.

### Task 7.2: Open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin dmitriy_kuladmed
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(parsers): Google Maps + Google News parsers" --body "$(cat <<'EOF'
## Summary
- Two new parser tabs on `/parsers`: Google Maps and Google News
- Ports Jacob's standalone `google-maps-news-parsers` package into portal infra
- New docker services: `googleparsers` (Playwright), `worker-googleparsers` (job runner)
- 4 new Supabase tables + RLS: `google_maps_jobs`, `google_maps_places`, `google_news_jobs`, `google_news_results`
- Follows Yandex Maps parser pattern end-to-end

## Test plan
- [ ] Smoke: Google Maps job with 1 query — completes, results table populates, CSV downloads
- [ ] Smoke: Google News job with 1 query — completes, CSV format matches Outscraper
- [ ] `Add to /tools/databases` button carries fields correctly
- [ ] Pause / Resume / Stop transitions work
- [ ] `.env` on prod has `GOOGLEPARSERS_PROXY_ENCRYPTION_KEY` (generated via `openssl rand -hex 32`)
- [ ] Docker compose config lints on prod

## Deploy notes
Requires one new env var on prod before `docker compose up -d`:
```
GOOGLEPARSERS_PROXY_ENCRYPTION_KEY=<openssl rand -hex 32>
```
EOF
)"
```

- [ ] **Step 3: Post PR URL back to Dmitry for merge and prod deploy**

---

## Post-merge deployment checklist (owned by Dmitry, not agent)

1. SSH to prod (`139.60.162.12`)
2. `openssl rand -hex 32` — copy output, paste into `.env` as `GOOGLEPARSERS_PROXY_ENCRYPTION_KEY=<hex>`
3. `docker compose pull googleparsers worker-googleparsers app`
4. `docker compose up -d googleparsers worker-googleparsers app`
5. Migration runs automatically on next Next.js start; or manually: `psql < supabase/migrations/20260707_0001_create_google_parsers_tables.sql`
6. Open `https://portal.<domain>/parsers` → verify Google Maps + Google News tabs appear
7. Run a 1-query smoke test in prod
