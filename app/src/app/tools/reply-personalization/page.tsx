import { Suspense } from 'react';
import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { ReplyPersonalizationTabs } from '@/components/reply-personalization/ReplyPersonalizationTabs';

export default function ReplyPersonalizationPage() {
  return (
    <InDevelopmentGate toolId="reply-personalization">
      <div className="h-[calc(100vh-4rem)]">
        {/* Вкладка читается из адреса (useSearchParams) — ему нужна граница Suspense. */}
        <Suspense fallback={null}>
          <ReplyPersonalizationTabs />
        </Suspense>
      </div>
    </InDevelopmentGate>
  );
}
