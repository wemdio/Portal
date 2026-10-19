import { PortalSpinner } from '@/components/PortalSpinner';

export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <PortalSpinner />
    </div>
  );
}
