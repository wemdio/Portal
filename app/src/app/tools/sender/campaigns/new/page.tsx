import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { CampaignForm } from '@/components/sender/CampaignForm';

/** Новая кампания «Рассылки» — отдельная страница вместо окна поверх списка. */
export default function NewCampaignPage() {
  return (
    <InDevelopmentGate toolId="sender">
      <CampaignForm />
    </InDevelopmentGate>
  );
}
