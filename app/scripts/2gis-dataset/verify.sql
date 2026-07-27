\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() <> '2gis_dataset' THEN
    RAISE EXCEPTION
      'Refusing 2GIS verification: expected database 2gis_dataset, got %',
      current_database();
  END IF;
END
$guard$;

SELECT
  current_database() AS database_name,
  (SELECT count(*) FROM public.cards) AS cards,
  (SELECT count(DISTINCT id) FROM public.cards) AS unique_ids,
  (SELECT count(*) FROM public.cards WHERE btrim(id) = '') AS blank_ids,
  (SELECT count(*) FROM public.facet_cities) AS cities,
  (SELECT count(*) FROM public.facet_categories) AS categories,
  (SELECT count(*) FROM public.card_subcategories) AS normalized_subcategories,
  (SELECT count(*) FROM public.facet_subcategories) AS subcategory_facets,
  (
    SELECT json_build_object(
      'scope', scope,
      'snapshot_date', snapshot_date,
      'source_filename', source_filename,
      'source_sha256', source_sha256,
      'source_rows', source_rows,
      'accepted_rows', accepted_rows,
      'rejected_rows', rejected_rows,
      'imported_at', imported_at
    )
    FROM public.dataset_snapshots
    ORDER BY imported_at DESC
    LIMIT 1
  ) AS latest_snapshot;
