'use client';

import { EngDashboard } from '@/components/client-eng/EngDashboard';

/**
 * /client/eng/dashboard — ENG Command Center: общий живой экран по всем
 * проектам клиента (этапы вертикалей, статистика дня, авто-добор, события).
 * Дефолтная точка входа в ENG-кабинет, когда проекты уже есть (список
 * проектов сам перенаправляет сюда); тексты страницы — английские.
 */
export default function ClientEngDashboardPage() {
  return (
    <div className="mx-auto max-w-4xl xl:max-w-6xl">
      <EngDashboard />
    </div>
  );
}
