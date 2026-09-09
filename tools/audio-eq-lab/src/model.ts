export const ANALYSIS_FREQUENCIES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 12000] as const;
export const EQ_FREQUENCIES = [80, 250, 1000, 3500, 10000] as const;

export type StyleProfileId = 'rock' | 'pop' | 'electronic' | 'acoustic' | 'classical';
export type InterventionLevel = 'off' | 'gentle' | 'balanced' | 'intense';
export type RecipeSelection = InterventionLevel | 'diagnostic';
export type TagScope = 'track' | 'album' | 'artist';

export interface ScopedTags {
  track: string[];
  album: string[];
  artist: string[];
}

export interface SpectrumBand {
  frequency: number;
  db: number;
  relativeDb: number;
}

export interface TrackAnalysis {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  samplePeakDbfs: number;
  rmsDbfs: number;
  crestDb: number;
  clippedSamples: number;
  clippedRatio: number;
  impulseCandidates: number;
  spectrum: SpectrumBand[];
  auditionSegments: AuditionSegment[];
}

export interface AuditionSegment {
  id: string;
  label: string;
  startSeconds: number;
  durationSeconds: number;
  rmsDbfs: number;
}

export interface DynamicRule {
  id: string;
  label: string;
  frequency: number;
  q: number;
  thresholdRelativeDb: number;
  maxReductionDb: number;
  attackMs: number;
  releaseMs: number;
}

export interface StyleProfileDefinition {
  id: StyleProfileId;
  label: string;
  description: string;
  gainsDb: readonly number[];
  tags: readonly string[];
  dynamicRules: readonly DynamicRule[];
}

export interface ProfileAffinity {
  profileId: StyleProfileId;
  score: number;
}

export interface ProfileInference {
  affinities: ProfileAffinity[];
  evidence: string[];
  confidence: number;
}

export interface RecipeBand {
  frequency: number;
  baseGainDb: number;
  adaptationDb: number;
  gainDb: number;
}

export interface AudioRecipe {
  schemaVersion: 2;
  engineVersion: string;
  selection: RecipeSelection;
  resolvedLabel: string;
  intensity: number;
  bypass: boolean;
  adaptationEnabled: boolean;
  dynamicEnabled: boolean;
  preampDb: number;
  bands: RecipeBand[];
  dynamicRules: DynamicRule[];
  affinities: ProfileAffinity[];
  evidence: string[];
  analysis: TrackAnalysis | null;
}

export interface ComparisonTrims {
  dryDb: number;
  wetDb: number;
  measuredDeltaDb: number;
  method: 'segment-rms-static-chain';
}
