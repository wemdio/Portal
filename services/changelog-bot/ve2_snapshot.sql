-- Compact, read-only projection. Never load candidates, contacts or whole collect_info.
WITH selected AS MATERIALIZED (
  SELECT pr.*, p.name AS project, h.title AS hypothesis
  FROM public.ve_outreach_setups s
  CROSS JOIN unnest(s.selected_hypothesis_ids) hid
  JOIN public.ve_outreach_preparations pr ON pr.project_id=s.project_id AND pr.hypothesis_id=hid
  JOIN public.ve_projects p ON p.id=s.project_id
  JOIN public.ve_hypotheses h ON h.id=hid AND h.project_id=s.project_id
  WHERE pr.cancelled_at IS NULL AND h.status <> 'rejected'
), bases AS MATERIALIZED (
  SELECT s.*, b.status AS base_status, b.error AS base_error,
    b.source, b.collect_info->'target_progress' AS target,
    t.status AS template_status
  FROM selected s
  LEFT JOIN public.ve_bases b ON b.id=s.base_id AND b.project_id=s.project_id AND b.hypothesis_id=s.hypothesis_id
  LEFT JOIN public.ve_templates t ON t.id=s.template_id AND t.base_id=b.id AND t.supply_batch_id IS NULL
)
SELECT jsonb_build_object(
  'key',b.project_id::text || ':' || b.hypothesis_id::text,
  'base_id',b.base_id,'project',b.project,'hypothesis',b.hypothesis,
  'prep_status',b.status,'prep_error',b.last_error IS NOT NULL,
  'prep_updated',b.updated_at,'base_status',b.base_status,'base_error',b.base_error IS NOT NULL,
  'source',b.source,'target',b.target,'template_status',b.template_status,
  'jobs',coalesce((
    SELECT jsonb_agg(to_jsonb(j)) FROM (
      SELECT DISTINCT ON (stage) stage,status,started_at,finished_at,updated_at,created_at
      FROM public.ve_jobs
      WHERE project_id=b.project_id AND payload->>'base_id'=b.base_id::text
        AND stage IN ('base_collect','base_analyze','template')
        AND nullif(payload->>'supply_batch_id','') IS NULL
      ORDER BY stage,created_at DESC,id DESC
    ) j
  ),'[]'::jsonb)
) AS item FROM bases b ORDER BY b.project,b.hypothesis,b.base_id;
