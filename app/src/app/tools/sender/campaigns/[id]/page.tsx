import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { CampaignForm } from '@/components/sender/CampaignForm';
import { SenderRailFrame } from '@/components/sender/SenderRail';

/**
 * Настройки существующей кампании «Рассылки». Сама кампания грузится формой по
 * id из адреса — на страницу можно зайти по ссылке, не открывая список.
 */
export default async function CampaignSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <InDevelopmentGate toolId="sender">
      <SenderRailFrame>
        <CampaignForm campaignId={id} />
      </SenderRailFrame>
    </InDevelopmentGate>
  );
}
