import { describe, expect, it } from 'vitest';
import type { TrackAnalysis } from './model';
import { buildRecipe, inferProfiles } from './profiles';

describe('profile inference', () => {
  it('usa etiquetas como evidencia dominante y conserva mezcla multietiqueta', () => {
    const inference = inferProfiles(['hard rock', 'alternative rock', 'electronic'], null);

    expect(inference.affinities[0]?.profileId).toBe('rock');
    expect(inference.affinities.find((item) => item.profileId === 'electronic')?.score).toBeGreaterThan(0.1);
    expect(inference.evidence).toHaveLength(3);
  });

  it('mantiene poca confianza cuando solo existe evidencia acústica', () => {
    const inference = inferProfiles([], analysisFixture({ crestDb: 14 }));
    const topScore = inference.affinities[0]?.score ?? 0;

    expect(inference.affinities[0]?.profileId).toBe('classical');
    expect(topScore).toBeLessThan(0.5);
  });
});

describe('recipe building', () => {
  it('Flat es un bypass estricto aunque se soliciten adaptaciones', () => {
    const inference = inferProfiles(['rock'], analysisFixture());
    const recipe = buildRecipe({
      selection: 'flat',
      inference,
      analysis: analysisFixture(),
      intensityPercent: 100,
      adaptationEnabled: true,
      dynamicEnabled: true,
    });

    expect(recipe.bypass).toBe(true);
    expect(recipe.preampDb).toBe(0);
    expect(recipe.dynamicRules).toEqual([]);
    expect(recipe.bands.every((band) => band.gainDb === 0)).toBe(true);
  });

  it('reserva headroom cuando un perfil introduce ganancias', () => {
    const inference = inferProfiles(['rock'], null);
    const recipe = buildRecipe({
      selection: 'rock',
      inference,
      analysis: null,
      intensityPercent: 60,
      adaptationEnabled: false,
      dynamicEnabled: true,
    });

    expect(recipe.bypass).toBe(false);
    expect(recipe.preampDb).toBeLessThan(0);
    expect(recipe.dynamicRules).toHaveLength(3);
    expect(recipe.bands.some((band) => band.gainDb > 0)).toBe(true);
  });

  it('la prueba de cableado es extrema, fija y libre de adaptación', () => {
    const inference = inferProfiles(['rock'], analysisFixture());
    const recipe = buildRecipe({
      selection: 'diagnostic',
      inference,
      analysis: analysisFixture(),
      intensityPercent: 10,
      adaptationEnabled: true,
      dynamicEnabled: true,
    });

    expect(recipe.resolvedLabel).toBe('Prueba de cableado');
    expect(recipe.preampDb).toBe(-9);
    expect(recipe.adaptationEnabled).toBe(false);
    expect(recipe.dynamicEnabled).toBe(false);
    expect(Math.max(...recipe.bands.map((band) => Math.abs(band.gainDb)))).toBeGreaterThanOrEqual(12);
  });

  it('la adaptación solo reduce una resonancia medida', () => {
    const analysis = analysisFixture({
      spectrum: [
        { frequency: 63, db: -30, relativeDb: 0 },
        { frequency: 125, db: -30, relativeDb: 0 },
        { frequency: 250, db: -20, relativeDb: 10 },
        { frequency: 500, db: -30, relativeDb: 0 },
        { frequency: 1000, db: -30, relativeDb: 0 },
        { frequency: 2000, db: -30, relativeDb: 0 },
        { frequency: 4000, db: -30, relativeDb: 0 },
        { frequency: 8000, db: -30, relativeDb: 0 },
        { frequency: 12000, db: -30, relativeDb: 0 },
      ],
    });
    const recipe = buildRecipe({
      selection: 'rock',
      inference: inferProfiles(['rock'], analysis),
      analysis,
      intensityPercent: 100,
      adaptationEnabled: true,
      dynamicEnabled: false,
    });

    const adapted = recipe.bands.find((band) => band.frequency === 250);
    expect(adapted?.adaptationDb).toBeLessThan(0);
    expect(recipe.bands.every((band) => band.adaptationDb <= 0)).toBe(true);
  });
});

function analysisFixture(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    durationSeconds: 180,
    sampleRate: 44_100,
    channels: 2,
    samplePeakDbfs: -1,
    rmsDbfs: -12,
    crestDb: 11,
    clippedSamples: 0,
    clippedRatio: 0,
    impulseCandidates: 0,
    spectrum: [
      { frequency: 63, db: -30, relativeDb: 0 },
      { frequency: 125, db: -30, relativeDb: 0 },
      { frequency: 250, db: -30, relativeDb: 0 },
      { frequency: 500, db: -30, relativeDb: 0 },
      { frequency: 1000, db: -30, relativeDb: 0 },
      { frequency: 2000, db: -30, relativeDb: 0 },
      { frequency: 4000, db: -30, relativeDb: 0 },
      { frequency: 8000, db: -30, relativeDb: 0 },
      { frequency: 12000, db: -30, relativeDb: 0 },
    ],
    ...overrides,
  };
}
