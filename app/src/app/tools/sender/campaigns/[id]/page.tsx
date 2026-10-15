import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { CampaignOverview } from '@/components/sender/CampaignOverview';
import { SenderRailFrame } from '@/components/sender/SenderRail';

/**
 * Кампания «Рассылки»: статистика, как «Analytics» в Instantly. Настройки — за
 * шестерёнкой, на /tools/sender/campaigns/<id>/settings.
 */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <InDevelopmentGate toolId="sender">
      <SenderRailFrame>
        <CampaignOverview campaignId={id} />
      </SenderRailFrame>
    </InDevelopmentGate>
  );
}
