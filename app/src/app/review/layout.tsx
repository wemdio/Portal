import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Просмотр базы',
  description: 'Гостевой доступ к базе для согласования',
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {children}
    </div>
  );
}
