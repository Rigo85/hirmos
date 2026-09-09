import {
  EQ_FREQUENCIES,
  type AudioRecipe,
  type DynamicRule,
  type InterventionLevel,
  type ProfileAffinity,
  type ProfileInference,
  type RecipeSelection,
  type ScopedTags,
  type StyleProfileDefinition,
  type StyleProfileId,
  type TagScope,
  type TrackAnalysis,
} from './model';

export const ENGINE_VERSION = 'hirmos-audio-lab/0.2.0';

interface InterventionDefinition {
  label: string;
  description: string;
  styleScale: number;
  adaptationScale: number;
  dynamicScale: number;
  maxBoostDb: number;
  maxCutDb: number;
}

export const INTERVENTIONS: Record<InterventionLevel, InterventionDefinition> = {
  off: {
    label: 'Sin EQ',
    description: 'Ruta original, sin procesamiento de contenido.',
    styleScale: 0,
    adaptationScale: 0,
    dynamicScale: 0,
    maxBoostDb: 0,
    maxCutDb: 0,
  },
  gentle: {
    label: 'Suave',
    description: 'Correcciones pequeñas y de alta confianza.',
    styleScale: 0.55,
    adaptationScale: 0.55,
    dynamicScale: 0.5,
    maxBoostDb: 1.25,
    maxCutDb: 1.5,
  },
  balanced: {
    label: 'Equilibrada',
    description: 'Compromiso recomendado entre contexto y medición.',
    styleScale: 1,
    adaptationScale: 1,
    dynamicScale: 1,
    maxBoostDb: 2.25,
    maxCutDb: 3,
  },
  intense: {
    label: 'Intensa',
    description: 'Transformación claramente audible, siempre acotada.',
    styleScale: 1.55,
    adaptationScale: 1.5,
    dynamicScale: 1.35,
    maxBoostDb: 3.75,
    maxCutDb: 4.5,
  },
};

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

// Estas familias son componentes internos de una receta. No son presets que el oyente elige.
export const STYLE_PROFILES: Record<StyleProfileId, StyleProfileDefinition> = {
  rock: {
    id: 'rock',
    label: 'Rock',
    description: 'Grave firme, medios presentes y ataque moderado.',
    gainsDb: [1.2, -0.35, 0.7, 1.1, 0.45],
    tags: ['rock', 'hard rock', 'alternative rock', 'grunge', 'metal', 'punk', 'progressive rock', 'progressive metal'],
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

const selectableProfiles = Object.keys(STYLE_PROFILES) as StyleProfileId[];
const scopeWeights: Record<TagScope, number> = { track: 4, album: 2, artist: 0.8 };
const scopeLabels: Record<TagScope, string> = { track: 'pista', album: 'álbum', artist: 'artista' };

export function inferProfiles(tags: ScopedTags, analysis: TrackAnalysis | null): ProfileInference {
  const scores = new Map<StyleProfileId, number>(selectableProfiles.map((profileId) => [profileId, 0.35]));
  const evidence: string[] = [];
  let semanticMatches = 0;

  for (const scope of ['track', 'album', 'artist'] as const) {
    for (const tag of tags[scope].map(normalizeTag).filter(Boolean)) {
      const matches = selectableProfiles.filter((profileId) => STYLE_PROFILES[profileId].tags.some((candidate) => {
        const normalizedCandidate = normalizeTag(candidate);
        return tag === normalizedCandidate || tag.includes(normalizedCandidate) || normalizedCandidate.includes(tag);
      }));
      if (matches.length === 0) continue;
      semanticMatches += 1;
      const contribution = scopeWeights[scope] / matches.length;
      for (const profileId of matches) addScore(scores, profileId, contribution);
      evidence.push(`“${tag}” en ${scopeLabels[scope]} orienta ${matches.map((id) => STYLE_PROFILES[id].label).join('/')} (${formatWeight(scopeWeights[scope])}).`);
    }
  }

  if (analysis) {
    if (analysis.crestDb >= 13) {
      addScore(scores, 'classical', 0.9);
      addScore(scores, 'acoustic', 0.65);
      evidence.push(`Crest factor de ${analysis.crestDb.toFixed(1)} dB: favorece una base poco invasiva.`);
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
      evidence.push('La medición muestra peso relativo en graves; es evidencia débil, no una etiqueta de género.');
    }
    if (upper > 1.5) {
      addScore(scores, 'pop', 0.45);
      addScore(scores, 'electronic', 0.3);
      evidence.push('La medición muestra presencia relativa en agudos; es evidencia débil, no una etiqueta de género.');
    }
  }

  if (evidence.length === 0) {
    evidence.push('Sin evidencia fuerte: se conserva una receta neutra de baja confianza.');
  }

  const total = [...scores.values()].reduce((sum, score) => sum + score, 0) || 1;
  const affinities = selectableProfiles
    .map((profileId) => ({ profileId, score: (scores.get(profileId) ?? 0) / total }))
    .sort((left, right) => right.score - left.score);
  const margin = (affinities[0]?.score ?? 0) - (affinities[1]?.score ?? 0);
  const confidence = round(clamp(0.15 + margin * 1.4 + Math.min(0.45, semanticMatches * 0.12), 0.15, 0.95));

  return { affinities, evidence, confidence };
}

export function buildRecipe(options: {
  selection: RecipeSelection;
  inference: ProfileInference;
  analysis: TrackAnalysis | null;
}): AudioRecipe {
  if (options.selection === 'off') {
    return {
      schemaVersion: 2,
      engineVersion: ENGINE_VERSION,
      selection: 'off',
      resolvedLabel: INTERVENTIONS.off.label,
      intensity: 0,
      bypass: true,
      adaptationEnabled: false,
      dynamicEnabled: false,
      preampDb: 0,
      bands: EQ_FREQUENCIES.map((frequency) => ({ frequency, baseGainDb: 0, adaptationDb: 0, gainDb: 0 })),
      dynamicRules: [],
      affinities: options.inference.affinities,
      evidence: ['Sin EQ: ruta seca, sin procesamiento de contenido.'],
      analysis: options.analysis,
    };
  }
  if (options.selection === 'diagnostic') {
    const diagnosticGains = [6, -9, -12, 8, -10] as const;
    return {
      schemaVersion: 2,
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

  const intervention = INTERVENTIONS[options.selection];
  const weights = resolveWeights(options.inference.affinities);
  const bands = EQ_FREQUENCIES.map((frequency, index) => {
    const baseGainDb = [...weights.entries()].reduce(
      (sum, [profileId, weight]) => sum + (STYLE_PROFILES[profileId].gainsDb[index] ?? 0) * weight * intervention.styleScale,
      0,
    );
    const adaptationDb = options.analysis
      ? calculateResonanceReduction(options.analysis, frequency) * intervention.adaptationScale
      : 0;
    const gainDb = clamp(baseGainDb + adaptationDb, -intervention.maxCutDb, intervention.maxBoostDb);
    return {
      frequency,
      baseGainDb: round(baseGainDb),
      adaptationDb: round(adaptationDb),
      gainDb: round(gainDb),
    };
  });
  const positiveGainBudget = bands.reduce((sum, band) => sum + Math.max(0, band.gainDb), 0);
  const preampDb = positiveGainBudget > 0 ? -round(Math.min(6, positiveGainBudget + 0.5)) : 0;
  const dynamicRules = blendDynamicRules(weights, intervention);
  const dominantStyle = options.inference.affinities[0];
  const styleLabel = dominantStyle
    ? `${STYLE_PROFILES[dominantStyle.profileId].label} ${Math.round(dominantStyle.score * 100)} %`
    : 'sin contexto dominante';

  return {
    schemaVersion: 2,
    engineVersion: ENGINE_VERSION,
    selection: options.selection,
    resolvedLabel: `${intervention.label} · ${styleLabel}`,
    intensity: intervention.styleScale,
    bypass: false,
    adaptationEnabled: Boolean(options.analysis),
    dynamicEnabled: true,
    preampDb,
    bands,
    dynamicRules,
    affinities: options.inference.affinities,
    evidence: [
      ...options.inference.evidence,
      `${intervention.label}: boosts ≤ ${intervention.maxBoostDb.toFixed(2)} dB, cortes ≤ ${intervention.maxCutDb.toFixed(2)} dB.`,
    ],
    analysis: options.analysis,
  };
}

export function recipeDistance(left: AudioRecipe, right: AudioRecipe): number {
  const bandDistance = left.bands.reduce(
    (sum, band, index) => sum + Math.abs(band.gainDb - (right.bands[index]?.gainDb ?? 0)),
    0,
  ) / Math.max(1, left.bands.length);
  const dynamicDistance = left.dynamicRules.reduce(
    (sum, rule, index) => sum + Math.abs(rule.maxReductionDb - (right.dynamicRules[index]?.maxReductionDb ?? 0)),
    0,
  ) / Math.max(1, left.dynamicRules.length || 1);
  return round(bandDistance + dynamicDistance * 0.35);
}

function resolveWeights(affinities: readonly ProfileAffinity[]): Map<StyleProfileId, number> {
  const candidates = affinities.slice(0, 3);
  const total = candidates.reduce((sum, affinity) => sum + affinity.score, 0) || 1;
  return new Map(candidates.map((affinity) => [affinity.profileId, affinity.score / total]));
}

function blendDynamicRules(
  weights: ReadonlyMap<StyleProfileId, number>,
  intervention: InterventionDefinition,
): DynamicRule[] {
  return sharedDynamicRules.map((baseRule) => {
    const maxReductionDb = [...weights.entries()].reduce((sum, [profileId, weight]) => {
      const rule = STYLE_PROFILES[profileId].dynamicRules.find((candidate) => candidate.id === baseRule.id);
      return sum + (rule?.maxReductionDb ?? 0) * weight;
    }, 0);
    return {
      ...baseRule,
      maxReductionDb: round(Math.min(intervention.maxCutDb, maxReductionDb * intervention.dynamicScale)),
    };
  });
}

function calculateResonanceReduction(analysis: TrackAnalysis, targetFrequency: number): number {
  if (targetFrequency <= 100 || targetFrequency >= 9000) return 0;
  const spectrum = analysis.spectrum;
  const closestIndex = spectrum.reduce((bestIndex, band, index) => {
    const currentDistance = Math.abs(Math.log2(band.frequency / targetFrequency));
    const bestDistance = Math.abs(Math.log2((spectrum[bestIndex]?.frequency ?? band.frequency) / targetFrequency));
    return currentDistance < bestDistance ? index : bestIndex;
  }, 0);
  const current = spectrum[closestIndex];
  const left = spectrum[Math.max(0, closestIndex - 1)];
  const right = spectrum[Math.min(spectrum.length - 1, closestIndex + 1)];
  if (!current || !left || !right) return 0;
  const prominence = current.relativeDb - (left.relativeDb + right.relativeDb) / 2;
  return prominence > 3 ? -Math.min(1.5, (prominence - 3) * 0.35) : 0;
}

function averageRelativeDb(analysis: TrackAnalysis, frequencies: readonly number[]): number {
  const bands = analysis.spectrum.filter((band) => frequencies.includes(band.frequency));
  return bands.length === 0 ? 0 : bands.reduce((sum, band) => sum + band.relativeDb, 0) / bands.length;
}

function normalizeTag(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function addScore(scores: Map<StyleProfileId, number>, profileId: StyleProfileId, amount: number): void {
  scores.set(profileId, (scores.get(profileId) ?? 0) + amount);
}

function formatWeight(value: number): string {
  return value >= 4 ? 'evidencia directa' : value >= 2 ? 'contexto de edición' : 'fallback débil';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
