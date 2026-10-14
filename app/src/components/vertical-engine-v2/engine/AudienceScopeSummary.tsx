import { VeAudienceScopeSchema } from '@/lib/verticalEngineV2/audienceScope';
import { HE } from './design';

/** The scope is the same saved definition used by collection. Legacy copy is
 * preserved until that hypothesis is explicitly replaced by a new audience. */
export function AudienceScopeSummary({ id, scope, description }: {
  id: string;
  scope?: unknown;
  description: string;
}) {
  if (scope === null || scope === undefined) return <span id={id} className={HE.muted}>{description}</span>;
  const parsed = VeAudienceScopeSchema.safeParse(scope);
  if (!parsed.success) return <span id={id} className="text-sm text-[var(--ve2-err)]">Не удалось прочитать условия аудитории. Обновите страницу.</span>;
  const audience = parsed.data;
  return <span id={id} className={`block max-w-[75ch] space-y-1 ${HE.muted}`}>
    <span className="block"><span className="font-medium">Кого собираем: </span>{audience.any_of.join('; ')}.</span>
    {audience.required.length ? <span className="block"><span className="font-medium">Обязательные условия: </span>{audience.required.join('; ')}.</span> : null}
    {audience.excluded.length ? <span className="block"><span className="font-medium">Исключаем: </span>{audience.excluded.join('; ')}.</span> : null}
  </span>;
}
