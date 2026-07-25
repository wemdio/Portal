/**
 * «Движок вертикалей» (Hypothesis Engine): бизнес-логика research-пайплайна
 * сайт → вертикали → цепочки/вокабуляр → база → шаблон 85/15.
 *
 * Внешняя точка входа — runHeStage (stages/): воркер клеймит he_jobs-строку
 * и передаёт supabaseAdmin-клиент + опциональные fetchText/search.
 */

export * from './types';
export * from './schemas';
export * from './stages';
