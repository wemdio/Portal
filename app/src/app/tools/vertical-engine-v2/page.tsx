'use client';

import { Inter, JetBrains_Mono } from 'next/font/google';

import { VerticalEngineV2View } from '@/components/vertical-engine-v2/VerticalEngineV2View';

/**
 * Scoped дизайн-слой страницы (редизайн): все правила под .ve2, на другие
 * страницы и глобальные стили портала не влияет. Импорт здесь, а не в
 * компоненте: глобальный CSS в App Router подключается из файлов app/.
 */
import '@/components/vertical-engine-v2/ve2.css';

const ve2Inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--ve2-font-body',
});

const ve2Mono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  variable: '--ve2-font-mono',
});

/**
 * Hidden development route. Intentionally absent from toolsRegistry until
 * v2 has a real pipeline and the legacy internal UI can be cut over safely.
 */
export default function VerticalEngineV2Page() {
  return (
    <div className={`${ve2Inter.variable} ${ve2Mono.variable}`}>
      <VerticalEngineV2View />
    </div>
  );
}
