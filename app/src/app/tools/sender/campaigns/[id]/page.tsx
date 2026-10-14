import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { CampaignForm } from '@/components/sender/CampaignForm';

/**
 * Настройки существующей кампании «Рассылки». Сама кампания грузится формой по
 * id из адреса — на страницу можно зайти по ссылке, не открывая список.
 */
export default async function CampaignSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <InDevelopmentGate toolId="sender">
      <CampaignForm campaignId={id} />
    </InDevelopmentGate>
  );
}
