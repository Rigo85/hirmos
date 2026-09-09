import type { AudioRecipe } from './model';

export type EqMode = 'off' | 'general' | 'contextual';
export type EqScope = 'track' | 'album' | 'artist' | 'genre';
export type ToneBand = 'bass' | 'mid' | 'treble';
export type ToneTuningId = 'hifi' | 'wide' | 'audible';

export interface ToneCurve {
  bass: number;
  mid: number;
  treble: number;
}

export interface ListeningContext {
  track: string;
  album: string;
  artist: string;
  genre: string;
}

export interface StoredToneProfile {
  scope: EqScope;
  key: string;
  label: string;
  curve: ToneCurve;
  updatedAt: string;
}

export interface ResolvedToneProfile {
  source: 'off' | 'general' | EqScope;
  label: string;
  curve: ToneCurve;
}

export interface ToneTuningDefinition {
  id: ToneTuningId;
  label: string;
  description: string;
  frequencies: Readonly<Record<ToneBand, number>>;
}

export const ENGINE_VERSION = 'hirmos-tone-lab/0.3.1';
export const NEUTRAL_CURVE: Readonly<ToneCurve> = { bass: 0, mid: 0, treble: 0 };
export const SCOPE_PRECEDENCE: readonly EqScope[] = ['track', 'album', 'artist', 'genre'];
export const TONE_TUNINGS: Record<ToneTuningId, ToneTuningDefinition> = {
  hifi: {
    id: 'hifi',
    label: 'Hi-Fi',
    description: 'Extremos más separados; el agudo trabaja principalmente brillo alto y aire.',
    frequencies: { bass: 100, mid: 1000, treble: 10_000 },
  },
  wide: {
    id: 'wide',
    label: 'Amplia',
    description: 'Cobertura intermedia y punto de partida actual del laboratorio.',
    frequencies: { bass: 120, mid: 1000, treble: 6000 },
  },
  audible: {
    id: 'audible',
    label: 'Más perceptible',
    description: 'Transiciones más cercanas al centro para que cuerpo, presencia y brillo sean evidentes.',
    frequencies: { bass: 150, mid: 1200, treble: 4000 },
  },
};

export const SCOPE_LABELS: Record<EqScope, string> = {
  track: 'Canción',
  album: 'Álbum',
  artist: 'Artista',
  genre: 'Género',
};

export function buildToneRecipe(
  resolved: ResolvedToneProfile,
  tuning: ToneTuningId = 'wide',
  maxGainDb: 6 | 12 = 6,
): AudioRecipe {
  const definition = TONE_TUNINGS[tuning];
  if (resolved.source === 'off') {
    return {
      schemaVersion: 2,
      engineVersion: ENGINE_VERSION,
      selection: 'off',
      resolvedLabel: 'Sin EQ',
      intensity: 0,
      bypass: true,
      adaptationEnabled: false,
      dynamicEnabled: false,
      preampDb: 0,
      bands: toneBands(NEUTRAL_CURVE, definition),
      dynamicRules: [],
      affinities: [],
      evidence: ['Ruta seca: el audio no atraviesa los filtros de tono.'],
      analysis: null,
    };
  }

  const curve = sanitizeCurve(resolved.curve, maxGainDb);
  const largestBoost = Math.max(0, curve.bass, curve.mid, curve.treble);
  const preampDb = largestBoost > 0 ? -round(largestBoost + 0.5) : 0;
  return {
    schemaVersion: 2,
    engineVersion: ENGINE_VERSION,
    selection: 'balanced',
    resolvedLabel: resolved.label,
    intensity: 1,
    bypass: false,
    adaptationEnabled: false,
    dynamicEnabled: false,
    preampDb,
    bands: toneBands(curve, definition),
    dynamicRules: [],
    affinities: [],
    evidence: [
      `${resolved.label}: Graves ${signed(curve.bass)} dB, Medios ${signed(curve.mid)} dB y Agudos ${signed(curve.treble)} dB.`,
      largestBoost > 0
        ? `Reserva común de ${Math.abs(preampDb).toFixed(1)} dB en A/B para reducir riesgo de saturación sin premiar la opción más fuerte.`
        : 'No se necesita reserva adicional porque la curva no amplifica ninguna banda.',
    ],
    analysis: null,
  };
}

export function resolveToneProfile(options: {
  mode: EqMode;
  general: ToneCurve;
  context: ListeningContext;
  profiles: readonly StoredToneProfile[];
  maxGainDb?: 6 | 12;
}): ResolvedToneProfile {
  const maxGainDb = options.maxGainDb ?? 6;
  if (options.mode === 'off') {
    return { source: 'off', label: 'Sin EQ', curve: copyCurve(NEUTRAL_CURVE) };
  }
  if (options.mode === 'general') {
    return { source: 'general', label: 'Ajuste general', curve: sanitizeCurve(options.general, maxGainDb) };
  }

  for (const scope of SCOPE_PRECEDENCE) {
    const value = options.context[scope];
    const key = profileKey(scope, value);
    if (!key) continue;
    const profile = options.profiles.find((candidate) => candidate.scope === scope && candidate.key === key);
    if (profile) {
      return { source: scope, label: `${SCOPE_LABELS[scope]} · ${profile.label}`, curve: sanitizeCurve(profile.curve, maxGainDb) };
    }
  }
  return { source: 'general', label: 'Ajuste general · sin coincidencia específica', curve: sanitizeCurve(options.general, maxGainDb) };
}

export function profileKey(scope: EqScope, value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
  return normalized ? `${scope}:${normalized}` : '';
}

export function sanitizeCurve(curve: ToneCurve, maxGainDb: 6 | 12 = 6): ToneCurve {
  return {
    bass: clampHalfDb(curve.bass, maxGainDb),
    mid: clampHalfDb(curve.mid, maxGainDb),
    treble: clampHalfDb(curve.treble, maxGainDb),
  };
}

export function copyCurve(curve: Readonly<ToneCurve>): ToneCurve {
  return { bass: curve.bass, mid: curve.mid, treble: curve.treble };
}

function toneBands(curve: Readonly<ToneCurve>, tuning: ToneTuningDefinition): AudioRecipe['bands'] {
  return [
    { frequency: tuning.frequencies.bass, baseGainDb: curve.bass, adaptationDb: 0, gainDb: curve.bass },
    { frequency: tuning.frequencies.mid, baseGainDb: curve.mid, adaptationDb: 0, gainDb: curve.mid },
    { frequency: tuning.frequencies.treble, baseGainDb: curve.treble, adaptationDb: 0, gainDb: curve.treble },
  ];
}

function clampHalfDb(value: number, maxGainDb: 6 | 12): number {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.round(Math.min(maxGainDb, Math.max(-maxGainDb, finite)) * 2) / 2;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
