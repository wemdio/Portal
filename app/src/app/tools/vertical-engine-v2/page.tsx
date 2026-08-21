'use client';

import { VerticalEngineV2View } from '@/components/vertical-engine-v2/VerticalEngineV2View';

/**
 * Hidden development route. Intentionally absent from toolsRegistry until
 * v2 has a real pipeline and the legacy internal UI can be cut over safely.
 */
export default function VerticalEngineV2Page() {
  return <VerticalEngineV2View />;
}
