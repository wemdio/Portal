import type { ToolHandler } from './types';
import { queryDatabase } from './sqlQuery';
import { getPipelineStatus, advanceAllPipelines } from './pipeline';

const queryDb: ToolHandler = async (params) => {
  const sql = params.sql as string | undefined;
  if (!sql) return 'Необходимо указать SQL-запрос.';
  return queryDatabase(sql);
};

const getAgentPipelineStatus: ToolHandler = async (params) => {
  await advanceAllPipelines().catch(() => {});
  return getPipelineStatus(params.pipeline_id as string | undefined, params._userId as string | undefined);
};

export const toolHandlers: Record<string, ToolHandler> = {
  query_database: queryDb,
  get_pipeline_status: getAgentPipelineStatus,
};
