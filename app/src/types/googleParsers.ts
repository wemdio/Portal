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
