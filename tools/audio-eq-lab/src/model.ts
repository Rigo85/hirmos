export const ANALYSIS_FREQUENCIES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 12000] as const;
export const EQ_FREQUENCIES = [80, 250, 1000, 3500, 10000] as const;

export type ProfileId = 'flat' | 'rock' | 'pop' | 'electronic' | 'acoustic' | 'classical';
export type ProfileSelection = ProfileId | 'auto' | 'diagnostic';

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

export interface ProfileDefinition {
  id: ProfileId;
  label: string;
  description: string;
  gainsDb: readonly number[];
  tags: readonly string[];
  dynamicRules: readonly DynamicRule[];
}

export interface ProfileAffinity {
  profileId: Exclude<ProfileId, 'flat'>;
  score: number;
}

export interface ProfileInference {
  affinities: ProfileAffinity[];
  evidence: string[];
}

export interface RecipeBand {
  frequency: number;
  baseGainDb: number;
  adaptationDb: number;
  gainDb: number;
}

export interface AudioRecipe {
  schemaVersion: 1;
  engineVersion: string;
  selection: ProfileSelection;
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
