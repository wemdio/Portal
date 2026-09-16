-- Classify only from durable parent IDs, including validation-only children
-- and consumed pipeline batches. Do not inspect/copy contacts or guess names.
with ve_refs as materialized (
  select b.id, c.construct, c.preview_pipeline, c.saved_email_recovery
  from public.ve_bases b
  cross join lateral jsonb_to_record(b.collect_info) as c(
    construct jsonb, preview_pipeline jsonb, saved_email_recovery jsonb
  )
  where b.source = 'auto'
), child_ids as (
  select construct->>'bc_job_id' as id from ve_refs
  union select saved_email_recovery->'batch'->>'id' from ve_refs
  union select batch->>'id' from ve_refs,
    lateral jsonb_array_elements(case when jsonb_typeof(preview_pipeline->'batches') = 'array'
      then preview_pipeline->'batches' else '[]'::jsonb end) batch
  union select job_id from ve_refs,
    lateral jsonb_array_elements_text(case when jsonb_typeof(preview_pipeline->'job_ids') = 'array'
      then preview_pipeline->'job_ids' else '[]'::jsonb end) job_id
  union select collect_info->'construct'->>'bc_job_id' from public.he_bases where source = 'auto'
  union select base_job_id::text from public.outreachos_pipeline_runs
)
update public.base_constructor_jobs j set workload_origin = 'automation'
where j.workload_origin is null and j.id::text in (select id from child_ids where id is not null);

-- Other existing jobs remain conservative manual work. New old-version
-- inserts during rollout stay NULL, so they cannot occupy manual-only workers.
-- The parent poller repairs those child origins from its checkpoint on resume.
update public.base_constructor_jobs set workload_origin = 'manual' where workload_origin is null;
