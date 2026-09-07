import {
  EQ_FREQUENCIES,
  type AudioRecipe,
  type DynamicRule,
  type ProfileAffinity,
  type ProfileDefinition,
  type ProfileId,
  type ProfileInference,
  type ProfileSelection,
  type TrackAnalysis,
} from './model';

export const ENGINE_VERSION = 'hirmos-audio-lab/0.1.0';

const sharedDynamicRules: readonly DynamicRule[] = [
  {
    id: 'boom',
    label: 'Grave',
    frequency: 125,
    q: 1.1,
    thresholdRelativeDb: 7,
    maxReductionDb: 2.4,
    attackMs: 90,
    releaseMs: 650,
  },
  {
    id: 'harshness',
    label: 'Aspereza',
    frequency: 3500,
    q: 1.45,
    thresholdRelativeDb: 5,
    maxReductionDb: 2.2,
    attackMs: 45,
    releaseMs: 420,
  },
  {
    id: 'brightness',
    label: 'Brillo',
    frequency: 8000,
    q: 1.25,
    thresholdRelativeDb: 4,
    maxReductionDb: 1.8,
    attackMs: 28,
    releaseMs: 320,
  },
];

export const PROFILES: Record<ProfileId, ProfileDefinition> = {
  flat: {
    id: 'flat',
    label: 'Flat',
    description: 'Ruta seca sin ecualización ni adaptación.',
    gainsDb: [0, 0, 0, 0, 0],
    tags: [],
    dynamicRules: [],
  },
  rock: {
    id: 'rock',
    label: 'Rock',
    description: 'Grave firme, medios presentes y ataque moderado.',
    gainsDb: [1.2, -0.35, 0.7, 1.1, 0.45],
    tags: ['rock', 'hard rock', 'alternative rock', 'grunge', 'metal', 'punk', 'progressive rock'],
    dynamicRules: sharedDynamicRules,
  },
  pop: {
    id: 'pop',
    label: 'Pop',
    description: 'Contorno ligero con presencia vocal y aire.',
    gainsDb: [0.75, -0.25, 0.35, 0.8, 0.9],
    tags: ['pop', 'synthpop', 'indie pop', 'dance pop', 'latin pop', 'k-pop'],
    dynamicRules: sharedDynamicRules,
  },
  electronic: {
    id: 'electronic',
    label: 'Electrónica',
    description: 'Extremos definidos con espacio en graves medios.',
    gainsDb: [1.55, -0.75, -0.15, 0.55, 1],
    tags: ['electronic', 'electronica', 'edm', 'techno', 'house', 'trance', 'industrial', 'dance'],
    dynamicRules: sharedDynamicRules,
  },
  acoustic: {
    id: 'acoustic',
    label: 'Acústica',
    description: 'Cuerpo contenido y detalle natural en presencia.',
    gainsDb: [0.2, -0.35, 0.45, 0.7, 0.25],
    tags: ['acoustic', 'folk', 'singer-songwriter', 'unplugged', 'country', 'bluegrass'],
    dynamicRules: sharedDynamicRules,
  },
  classical: {
    id: 'classical',
    label: 'Clásica',
    description: 'Intervención mínima para conservar rango dinámico.',
    gainsDb: [0.15, 0.15, 0, 0.25, 0.4],
    tags: ['classical', 'orchestral', 'symphonic', 'chamber', 'opera', 'baroque', 'romantic'],
    dynamicRules: sharedDynamicRules.map((rule) => ({
      ...rule,
      maxReductionDb: rule.maxReductionDb * 0.65,
    })),
  },
};

const selectableProfiles = ['rock', 'pop', 'electronic', 'acoustic', 'classical'] as const;

export function inferProfiles(tags: readonly string[], analysis: TrackAnalysis | null): ProfileInference {
  const scores = new Map<ProfileAffinity['profileId'], number>(
    selectableProfiles.map((profileId) => [profileId, 0.35]),
  );
  const evidence: string[] = [];
  const normalizedTags = tags
    .map((tag) => normalizeTag(tag))
    .filter((tag) => tag.length > 0);

  for (const tag of normalizedTags) {
    let matched = false;
    for (const profileId of selectableProfiles) {
      const profile = PROFILES[profileId];
      const bestMatch = profile.tags.some((candidate) => {
        const normalizedCandidate = normalizeTag(candidate);
        return tag === normalizedCandidate || tag.includes(normalizedCandidate) || normalizedCandidate.includes(tag);
      });
      if (bestMatch) {
        scores.set(profileId, (scores.get(profileId) ?? 0) + 3);
        matched = true;
      }
    }
    if (matched) {
      evidence.push(`La etiqueta “${tag}” aporta afinidad semántica.`);
    }
  }

  if (analysis) {
    if (analysis.crestDb >= 13) {
      addScore(scores, 'classical', 0.9);
      addScore(scores, 'acoustic', 0.65);
      evidence.push(`Crest factor de ${analysis.crestDb.toFixed(1)} dB: favorece perfiles poco invasivos.`);
    } else if (analysis.crestDb <= 8.5) {
      addScore(scores, 'pop', 0.55);
      addScore(scores, 'electronic', 0.45);
      addScore(scores, 'rock', 0.35);
      evidence.push(`Crest factor de ${analysis.crestDb.toFixed(1)} dB: mezcla densa o comprimida.`);
    }

    const low = averageRelativeDb(analysis, [63, 125]);
    const upper = averageRelativeDb(analysis, [4000, 8000]);
    if (low > 2.5) {
      addScore(scores, 'electronic', 0.7);
      addScore(scores, 'rock', 0.35);
      evidence.push('La distribución espectral muestra peso relativo en graves.');
    }
    if (upper > 1.5) {
      addScore(scores, 'pop', 0.45);
      addScore(scores, 'electronic', 0.3);
      evidence.push('La distribución espectral muestra presencia relativa en agudos.');
    }
  }

  if (evidence.length === 0) {
    evidence.push('Sin evidencia fuerte: las sugerencias acústicas conservan poco peso.');
  }

  const total = [...scores.values()].reduce((sum, score) => sum + score, 0);
  const affinities = selectableProfiles
    .map((profileId) => ({ profileId, score: (scores.get(profileId) ?? 0) / total }))
    .sort((left, right) => right.score - left.score);

  return { affinities, evidence };
}

export function buildRecipe(options: {
  selection: ProfileSelection;
  inference: ProfileInference;
  analysis: TrackAnalysis | null;
  intensityPercent: number;
  adaptationEnabled: boolean;
  dynamicEnabled: boolean;
}): AudioRecipe {
  const intensity = clamp(options.intensityPercent / 100, 0, 1);
  if (options.selection === 'flat') {
    return {
      schemaVersion: 1,
      engineVersion: ENGINE_VERSION,
      selection: 'flat',
      resolvedLabel: PROFILES.flat.label,
      intensity,
      bypass: true,
      adaptationEnabled: false,
      dynamicEnabled: false,
      preampDb: 0,
      bands: EQ_FREQUENCIES.map((frequency) => ({ frequency, baseGainDb: 0, adaptationDb: 0, gainDb: 0 })),
      dynamicRules: [],
      affinities: options.inference.affinities,
      evidence: ['Flat: ruta seca, sin ecualización ni procesamiento adaptativo.'],
      analysis: options.analysis,
    };
  }
  if (options.selection === 'diagnostic') {
    const diagnosticGains = [6, -9, -12, 8, -10] as const;
    return {
      schemaVersion: 1,
      engineVersion: ENGINE_VERSION,
      selection: 'diagnostic',
      resolvedLabel: 'Prueba de cableado',
      intensity: 1,
      bypass: false,
      adaptationEnabled: false,
      dynamicEnabled: false,
      preampDb: -9,
      bands: EQ_FREQUENCIES.map((frequency, index) => ({
        frequency,
        baseGainDb: diagnosticGains[index] ?? 0,
        adaptationDb: 0,
        gainDb: diagnosticGains[index] ?? 0,
      })),
      dynamicRules: [],
      affinities: options.inference.affinities,
      evidence: [
        'Prueba deliberadamente extrema: no representa una mejora musical.',
        'Si A/B no cambia radicalmente el sonido, la ruta procesada no está llegando a la salida.',
      ],
      analysis: options.analysis,
    };
  }

  const weights = resolveWeights(options.selection, options.inference.affinities);
  const bands = EQ_FREQUENCIES.map((frequency, index) => {
    const baseGainDb = [...weights.entries()].reduce(
      (sum, [profileId, weight]) => sum + (PROFILES[profileId].gainsDb[index] ?? 0) * weight * intensity,
      0,
    );
    const adaptationDb = options.adaptationEnabled && options.analysis
      ? calculateResonanceReduction(options.analysis, frequency) * intensity
      : 0;
    return {
      frequency,
      baseGainDb: round(baseGainDb),
      adaptationDb: round(adaptationDb),
      gainDb: round(baseGainDb + adaptationDb),
    };
  });
  const positiveGainBudget = bands.reduce((sum, band) => sum + Math.max(0, band.gainDb), 0);
  const preampDb = positiveGainBudget > 0 ? -round(Math.min(6, positiveGainBudget + 0.5)) : 0;
  const dynamicRules = options.dynamicEnabled
    ? blendDynamicRules(weights, intensity)
    : [];
  const resolvedLabel = options.selection === 'auto'
    ? weightsToLabel(weights)
    : PROFILES[options.selection].label;

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    selection: options.selection,
    resolvedLabel,
    intensity,
    bypass: false,
    adaptationEnabled: options.adaptationEnabled,
    dynamicEnabled: options.dynamicEnabled,
    preampDb,
    bands,
    dynamicRules,
    affinities: options.inference.affinities,
    evidence: options.inference.evidence,
    analysis: options.analysis,
  };
}

function resolveWeights(
  selection: Exclude<ProfileSelection, 'flat' | 'diagnostic'>,
  affinities: readonly ProfileAffinity[],
): Map<Exclude<ProfileId, 'flat'>, number> {
  if (selection !== 'auto') {
    return new Map([[selection, 1]]);
  }
  const candidates = affinities.slice(0, 3);
  const total = candidates.reduce((sum, affinity) => sum + affinity.score, 0) || 1;
  return new Map(candidates.map((affinity) => [affinity.profileId, affinity.score / total]));
}

function blendDynamicRules(
  weights: ReadonlyMap<Exclude<ProfileId, 'flat'>, number>,
  intensity: number,
): DynamicRule[] {
  return sharedDynamicRules.map((baseRule) => {
    const maxReductionDb = [...weights.entries()].reduce((sum, [profileId, weight]) => {
      const rule = PROFILES[profileId].dynamicRules.find((candidate) => candidate.id === baseRule.id);
      return sum + (rule?.maxReductionDb ?? 0) * weight;
    }, 0);
    return {
      ...baseRule,
      maxReductionDb: round(maxReductionDb * intensity),
    };
  });
}

function calculateResonanceReduction(analysis: TrackAnalysis, targetFrequency: number): number {
  if (targetFrequency <= 100 || targetFrequency >= 9000) {
    return 0;
  }
  const spectrum = analysis.spectrum;
  const closestIndex = spectrum.reduce((bestIndex, band, index) => {
    const currentDistance = Math.abs(Math.log2(band.frequency / targetFrequency));
    const bestDistance = Math.abs(Math.log2((spectrum[bestIndex]?.frequency ?? band.frequency) / targetFrequency));
    return currentDistance < bestDistance ? index : bestIndex;
  }, 0);
  const current = spectrum[closestIndex];
  const left = spectrum[Math.max(0, closestIndex - 1)];
  const right = spectrum[Math.min(spectrum.length - 1, closestIndex + 1)];
  if (!current || !left || !right) {
    return 0;
  }
  const neighbourAverage = (left.relativeDb + right.relativeDb) / 2;
  const prominence = current.relativeDb - neighbourAverage;
  return prominence > 3 ? -Math.min(1.5, (prominence - 3) * 0.35) : 0;
}

function weightsToLabel(weights: ReadonlyMap<Exclude<ProfileId, 'flat'>, number>): string {
  return [...weights.entries()]
    .slice(0, 2)
    .map(([profileId, weight]) => `${PROFILES[profileId].label} ${Math.round(weight * 100)} %`)
    .join(' · ');
}

function averageRelativeDb(analysis: TrackAnalysis, frequencies: readonly number[]): number {
  const bands = analysis.spectrum.filter((band) => frequencies.includes(band.frequency));
  return bands.length === 0 ? 0 : bands.reduce((sum, band) => sum + band.relativeDb, 0) / bands.length;
}

function normalizeTag(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function addScore(
  scores: Map<ProfileAffinity['profileId'], number>,
  profileId: ProfileAffinity['profileId'],
  amount: number,
): void {
  scores.set(profileId, (scores.get(profileId) ?? 0) + amount);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
