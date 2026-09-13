import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { ReplyPersonalizationView } from '@/components/reply-personalization/ReplyPersonalizationView';

export default function ReplyPersonalizationPage() {
  return (
    <InDevelopmentGate toolId="reply-personalization">
      <div className="h-[calc(100vh-4rem)]">
        <ReplyPersonalizationView />
      </div>
    </InDevelopmentGate>
  );
}
