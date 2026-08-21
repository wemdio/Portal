/**
 * «Движок вертикалей» (Hypothesis Engine): бизнес-логика research-пайплайна
 * сайт → вертикали → цепочки/вокабуляр → база → шаблон 85/15.
 *
 * Внешняя точка входа — runVeStage (stages/): воркер клеймит ve_jobs-строку
 * и передаёт supabaseAdmin-клиент + опциональные fetchText/search.
 */

export * from './types';
export * from './schemas';
export * from './stages';

export * from './legacyArchive';
export * from './legacyLinks';
export * from './projects';
export * from './types.legacy';
export * from './websiteUrl';
