'use client';

import { OutreachRunView } from '@/components/outreach/run/OutreachRunView';
import { polzaOutreachAdapter } from './polzaOutreachAdapter';

/** Английский автоаутрич: общий экран запуска с английскими шагами и данными. */
export function PolzaOutreachView() {
  return <OutreachRunView adapter={polzaOutreachAdapter} />;
}
