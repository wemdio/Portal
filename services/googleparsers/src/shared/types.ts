export type JobStatus = "queued" | "running" | "paused" | "stopped" | "completed" | "failed" | "captcha" | "blocked" | "timeout" | "login_required";

export type PlaceStatus = "ok" | "partial" | "captcha" | "blocked" | "timeout" | "error";

export interface ScrapeSettings {
  inputLines: string[];
  cities: string[];
  categories: string[];
  keyword: string;
  limitPerQuery: number;
  language: string;
  region: string;
  minDelayMs: number;
  maxDelayMs: number;
  proxies: string[];
  enrichContacts: boolean;
}

export interface SearchTarget {
  id: string;
  query: string;
  city: string;
  category: string;
  url: string;
  sourceUrl: string;
}

export interface PlaceResult {
  query: string;
  city: string;
  category: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  emails: string[];
  socials: string[];
  linkedInUrl: string;
  rating: string;
  reviewsCount: string;
  googleMapsUrl: string;
  placeId: string;
  googleId: string;
  latitude: string;
  longitude: string;
  dedupeKey: string;
  sourceUrl: string;
  status: PlaceStatus;
  error?: string;
}

export interface JobError {
  targetId?: string;
  message: string;
  at: string;
}

export interface ScrapeJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  settings: ScrapeSettings;
  targets: SearchTarget[];
  currentTargetIndex: number;
  processedPlaces: number;
  totalDiscovered: number;
  message: string;
  results: PlaceResult[];
  errors: JobError[];
}

export interface CreateJobResponse {
  job: ScrapeJob;
}

export interface JobSnapshotResponse {
  job: ScrapeJob;
}

export interface ListJobsResponse {
  jobs: ScrapeJob[];
}

export type NewsDateRange = "any" | "hour" | "day" | "week" | "month" | "year";

export interface NewsScrapeSettings {
  queries: string[];
  pagesLimit: number;
  country: string;
  language: string;
  dateRange: NewsDateRange;
  minDelayMs: number;
  maxDelayMs: number;
  proxies: string[];
}

export interface NewsTarget {
  id: string;
  query: string;
  page: number;
  url: string;
  sourceUrl: string;
}

export interface NewsResult {
  query: string;
  position: number;
  title: string;
  body: string;
  posted: string;
  source: string;
  link: string;
}

export interface NewsJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  settings: NewsScrapeSettings;
  targets: NewsTarget[];
  currentTargetIndex: number;
  processedResults: number;
  message: string;
  results: NewsResult[];
  errors: JobError[];
}

export interface CreateNewsJobResponse {
  job: NewsJob;
}

export interface NewsJobSnapshotResponse {
  job: NewsJob;
}

export interface ListNewsJobsResponse {
  jobs: NewsJob[];
}
