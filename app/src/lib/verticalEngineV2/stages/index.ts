/**
 * Диспетчер стадий «Движка вертикалей»: воркер клеймит ve_jobs-строку и
 * вызывает runVeStage(job, ctx). Контракт контекста/результата объявлен в
 * shared.ts и реэкспортирован здесь (единая точка входа).
 */

import type { VeJob } from '../types';
import type { VeStageContext, VeStageResult } from './shared';
import { runSiteProfileStage } from './siteProfile';
import { runCompetitorsStage } from './competitors';
import { runBrandCloudStage } from './brandCloud';
import { runHypothesesStage } from './hypotheses';
import { runEvidenceStage } from './evidence';
import { runClusteringStage } from './clustering';
import { runChainStage } from './chain';
import { runVocabStage } from './vocab';
import { runBaseAnalyzeStage } from './baseAnalyze';
import { runBaseCollectStage } from './baseCollect';
import { runTemplateStage } from './template';
import { runDossierStage } from './dossier';
import { runSegmentationAuditStage } from './segmentationAudit';

export type { VeStageContext, VeStageResult } from './shared';

export async function runVeStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  switch (job.stage) {
    case 'site_profile':
      return runSiteProfileStage(job, ctx);
    case 'competitors':
      return runCompetitorsStage(job, ctx);
    case 'brand_cloud':
      return runBrandCloudStage(job, ctx);
    case 'hypotheses':
      return runHypothesesStage(job, ctx);
    case 'evidence':
      return runEvidenceStage(job, ctx);
    case 'clustering':
      return runClusteringStage(job, ctx);
    case 'chain':
      return runChainStage(job, ctx);
    case 'vocab':
      return runVocabStage(job, ctx);
    case 'base_analyze':
      return runBaseAnalyzeStage(job, ctx);
    case 'base_collect':
      return runBaseCollectStage(job, ctx);
    case 'template':
      return runTemplateStage(job, ctx);
    case 'dossier':
      return runDossierStage(job, ctx);
    case 'segmentation_audit':
      return runSegmentationAuditStage(job, ctx);
    default: {
      const neverStage: never = job.stage;
      throw new Error(`Неизвестная стадия hypothesis engine: ${String(neverStage)}`);
    }
  }
}

export { runSiteProfileStage } from './siteProfile';
export { runCompetitorsStage } from './competitors';
export { runBrandCloudStage } from './brandCloud';
export { runHypothesesStage } from './hypotheses';
export { runEvidenceStage } from './evidence';
export { runClusteringStage, applyClusteringDecisions } from './clustering';
export type { AppliedVertical, ClusterHypothesisInput } from './clustering';
export { runChainStage, parsedToChainLetters, CHAIN_WAIT_DAYS } from './chain';
export { runVocabStage } from './vocab';
export { runBaseAnalyzeStage } from './baseAnalyze';
export { runBaseCollectStage } from './baseCollect';
export {
  runTemplateStage,
  extractPersonalizationOperators,
  mapOperatorsToColumns,
} from './template';
export { runDossierStage } from './dossier';
export {
  isStoredAuditCurrent,
  markSegmentationAuditFailed,
  prepareAuditSnapshot,
  runSegmentationAuditStage,
  toStoredAuditSummary,
  validateStoredAuditSnapshot,
} from './segmentationAudit';
export type {
  StoredAuditValidation,
  StoredAuditValidationInput,
} from './segmentationAudit';
