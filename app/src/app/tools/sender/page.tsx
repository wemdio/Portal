import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { SenderView } from '@/components/sender/SenderView';

export default function SenderPage() {
  return (
    <InDevelopmentGate toolId="sender">
      <SenderView />
    </InDevelopmentGate>
  );
}
