export type GuideControl = {
  name: string;
  description: string;
};

export type GuidePipelineStep = {
  title: string;
  description: string;
};

export type GuideSubchapter = {
  title: string;
  route?: string;
  details: string[];
};

export type GuidePageDoc = {
  title: string;
  route: string;
  purpose: string;
  controls: GuideControl[];
  subchapters?: GuideSubchapter[];
  pipeline: GuidePipelineStep[];
  states: string[];
  typicalIssues: string[];
};

export type GuideSection = {
  slug: string;
  title: string;
  summary: string;
  pages: GuidePageDoc[];
};
