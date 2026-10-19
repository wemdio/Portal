import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { CampaignForm } from '@/components/sender/CampaignForm';
import { SenderRailFrame } from '@/components/sender/SenderRail';

/** Новая кампания «Рассылки» — отдельная страница вместо окна поверх списка. */
export default function NewCampaignPage() {
  return (
    <InDevelopmentGate toolId="sender">
      <SenderRailFrame>
        <CampaignForm />
      </SenderRailFrame>
    </InDevelopmentGate>
  );
}
