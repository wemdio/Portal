'use client';

import { AutoOutreachProject } from './AutoOutreachProject';

export function ProjectDetail(props: { projectId: string; onBack: () => void }) {
  return <AutoOutreachProject key={props.projectId} {...props} />;
}

/** Shared CSV upload shape retained for existing base import components. */
export interface BaseUploadPayload {
  vertical_id: string;
  filename: string;
  columns: string[];
  rows: Array<Record<string, string>>;
}
