import { describe, expect, it } from 'vitest';
import type { ScopedTags, TrackAnalysis } from './model';
import { buildRecipe, inferProfiles, recipeDistance } from './profiles';

describe('semantic inference', () => {
  it('prioriza pista sobre álbum y artista sin perder evidencia multietiqueta', () => {
    const inference = inferProfiles({
      track: ['progressive metal'],
      album: ['electronic'],
      artist: ['pop'],
    }, null);

    expect(inference.affinities[0]?.profileId).toBe('rock');
    expect(inference.affinities.find((item) => item.profileId === 'electronic')?.score).toBeGreaterThan(0.1);
    expect(inference.evidence.some((item) => item.includes('evidencia directa'))).toBe(true);
    expect(inference.confidence).toBeGreaterThan(0.4);
  });

  it('mantiene poca confianza cuando solo existe evidencia acústica', () => {
    const inference = inferProfiles(emptyTags(), analysisFixture({ crestDb: 14 }));
    expect(inference.affinities[0]?.profileId).toBe('classical');
    expect(inference.confidence).toBeLessThan(0.5);
  });
});

describe('intervention recipes', () => {
  it('Sin EQ es un bypass estricto', () => {
    const recipe = buildRecipe({
      selection: 'off',
      inference: inferProfiles({ ...emptyTags(), track: ['rock'] }, analysisFixture()),
      analysis: analysisFixture(),
    });

    expect(recipe.schemaVersion).toBe(2);
    expect(recipe.bypass).toBe(true);
    expect(recipe.preampDb).toBe(0);
    expect(recipe.dynamicRules).toEqual([]);
    expect(recipe.bands.every((band) => band.gainDb === 0)).toBe(true);
  });

  it('escala la misma receta semántica por nivel y conserva límites', () => {
    const analysis = analysisFixture();
    const inference = inferProfiles({ ...emptyTags(), track: ['rock'] }, analysis);
    const gentle = buildRecipe({ selection: 'gentle', inference, analysis });
    const balanced = buildRecipe({ selection: 'balanced', inference, analysis });
    const intense = buildRecipe({ selection: 'intense', inference, analysis });

    expect(gentle.bypass).toBe(false);
    expect(gentle.dynamicRules).toHaveLength(3);
    expect(maxAbs(gentle)).toBeLessThan(maxAbs(balanced));
    expect(maxAbs(balanced)).toBeLessThan(maxAbs(intense));
    expect(maxAbs(intense)).toBeLessThanOrEqual(3.75);
    expect(recipeDistance(gentle, balanced)).toBeGreaterThan(0.25);
  });

  it('la prueba de cableado es extrema, fija y libre de adaptación', () => {
    const analysis = analysisFixture();
    const recipe = buildRecipe({
      selection: 'diagnostic',
      inference: inferProfiles({ ...emptyTags(), track: ['rock'] }, analysis),
      analysis,
    });

    expect(recipe.resolvedLabel).toBe('Prueba de cableado');
    expect(recipe.preampDb).toBe(-9);
    expect(recipe.adaptationEnabled).toBe(false);
    expect(recipe.dynamicEnabled).toBe(false);
    expect(maxAbs(recipe)).toBeGreaterThanOrEqual(12);
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
      selection: 'balanced',
      inference: inferProfiles({ ...emptyTags(), track: ['rock'] }, analysis),
      analysis,
    });

    const adapted = recipe.bands.find((band) => band.frequency === 250);
    expect(adapted?.adaptationDb).toBeLessThan(0);
    expect(recipe.bands.every((band) => band.adaptationDb <= 0)).toBe(true);
  });
});

function maxAbs(recipe: ReturnType<typeof buildRecipe>): number {
  return Math.max(...recipe.bands.map((band) => Math.abs(band.gainDb)));
}

function emptyTags(): ScopedTags {
  return { track: [], album: [], artist: [] };
}

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
    auditionSegments: [{ id: 'representative', label: 'Representativo', startSeconds: 0, durationSeconds: 18, rmsDbfs: -12 }],
    ...overrides,
  };
}
