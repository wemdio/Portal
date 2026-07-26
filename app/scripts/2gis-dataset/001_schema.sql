\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() <> '2gis_dataset' THEN
    RAISE EXCEPTION
      'Refusing 2GIS schema install: expected database 2gis_dataset, got %',
      current_database();
  END IF;
END
$guard$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.cards (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  name text NOT NULL DEFAULT '',
  city_name text NOT NULL DEFAULT '',
  geometry_name text NOT NULL DEFAULT '',
  post_code text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  website text NOT NULL DEFAULT '',
  vkontakte text NOT NULL DEFAULT '',
  instagram text NOT NULL DEFAULT '',
  lon text NOT NULL DEFAULT '',
  lat text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  subcategory text NOT NULL DEFAULT '',
  has_phone boolean GENERATED ALWAYS AS (btrim(phone) <> '') STORED,
  has_email boolean GENERATED ALWAYS AS (btrim(email) <> '') STORED,
  has_website boolean GENERATED ALWAYS AS (btrim(website) <> '') STORED,
  has_vkontakte boolean GENERATED ALWAYS AS (btrim(vkontakte) <> '') STORED,
  has_instagram boolean GENERATED ALWAYS AS (btrim(instagram) <> '') STORED
);

CREATE INDEX IF NOT EXISTS cards_city_name_id_idx ON public.cards (city_name, id);
CREATE INDEX IF NOT EXISTS cards_category_id_idx ON public.cards (category, id);
CREATE INDEX IF NOT EXISTS cards_city_category_id_idx ON public.cards (city_name, category, id);
CREATE INDEX IF NOT EXISTS cards_has_phone_id_idx ON public.cards (id) WHERE has_phone;
CREATE INDEX IF NOT EXISTS cards_has_email_id_idx ON public.cards (id) WHERE has_email;
CREATE INDEX IF NOT EXISTS cards_has_website_id_idx ON public.cards (id) WHERE has_website;
CREATE INDEX IF NOT EXISTS cards_has_vkontakte_id_idx ON public.cards (id) WHERE has_vkontakte;
CREATE INDEX IF NOT EXISTS cards_has_instagram_id_idx ON public.cards (id) WHERE has_instagram;
CREATE INDEX IF NOT EXISTS cards_name_trgm_idx ON public.cards USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS public.card_subcategories (
  card_id text NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT '',
  value text NOT NULL CHECK (btrim(value) <> ''),
  PRIMARY KEY (card_id, value)
);

CREATE INDEX IF NOT EXISTS card_subcategories_value_card_id_idx
  ON public.card_subcategories (value, card_id);
CREATE INDEX IF NOT EXISTS card_subcategories_category_value_card_id_idx
  ON public.card_subcategories (category, value, card_id);

CREATE TABLE IF NOT EXISTS public.dataset_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL DEFAULT 'Россия',
  snapshot_date date NOT NULL,
  source_filename text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_rows bigint NOT NULL,
  accepted_rows bigint NOT NULL,
  rejected_rows bigint NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.import_rejects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id bigint REFERENCES public.dataset_snapshots(id) ON DELETE CASCADE,
  reason text NOT NULL,
  source_row jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.facet_cities (
  value text PRIMARY KEY,
  row_count bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.facet_categories (
  value text PRIMARY KEY,
  row_count bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.facet_subcategories (
  category text NOT NULL,
  value text NOT NULL,
  row_count bigint NOT NULL,
  PRIMARY KEY (category, value)
);

CREATE TABLE IF NOT EXISTS public.export_tickets (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL,
  snapshot_id bigint NOT NULL REFERENCES public.dataset_snapshots(id),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS export_tickets_expires_at_idx
  ON public.export_tickets (expires_at);

CREATE UNLOGGED TABLE IF NOT EXISTS public.import_staging (
  id text,
  name text,
  city_name text,
  geometry_name text,
  post_code text,
  phone text,
  email text,
  website text,
  vkontakte text,
  instagram text,
  lon text,
  lat text,
  category text,
  subcategory text
);
