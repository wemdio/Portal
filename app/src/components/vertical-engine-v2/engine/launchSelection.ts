import type { VeOutreachSetupResponse } from '@/lib/verticalEngineV2/outreachSetup';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';

/** Preparation selection and launch selection are separate, explicit decisions. */
export function getVeLaunchSelectionState(
  snapshot: VeOutreachSetupResponse | null,
  templates: VeTemplate[],
  hypothesisId: string,
): { ready: boolean; launched?: boolean; label: string } {
  if (!snapshot?.setup.selected_hypothesis_ids.includes(hypothesisId)) {
    return { ready: false, label: 'Гипотеза не выбрана для подготовки' };
  }
  const preparation = snapshot.preparations.find((p) => p.hypothesis_id === hypothesisId);
  const template = templates.find((t) => t.id === preparation?.template_id);
  if (template && (template as VeTemplate & { launch_info?: unknown }).launch_info != null) {
    return { ready: false, launched: true, label: 'Уже передана в запуск, смотрите результаты' };
  }
  if (!preparation) return { ready: false, label: 'Подготовка ещё не начата' };
  if (preparation.status === 'error') return { ready: false, label: 'Ошибка подготовки, подробности ниже' };
  if (preparation.status !== 'ready' || !preparation.base_id || template?.status !== 'ready') {
    return { ready: false, label: 'Подготовка ещё не завершена' };
  }
  const review = snapshot.reviews[preparation.base_id];
  const approval = snapshot.setup.approved_bases[preparation.base_id];
  if (!review || review.template_id !== template.id) return { ready: false, label: 'Обновляется версия базы и писем' };
  if (approval?.revision !== review.revision || approval.template_id !== template.id) {
    return { ready: false, label: approval ? 'Нужно одобрить базу заново' : 'База и письма готовы, нужно одобрение' };
  }
  return { ready: true, label: 'Одобрена, готова к запуску' };
}
