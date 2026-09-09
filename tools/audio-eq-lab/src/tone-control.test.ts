import { describe, expect, it } from 'vitest';
import {
  buildToneRecipe,
  profileKey,
  resolveToneProfile,
  TONE_TUNINGS,
  type ListeningContext,
  type StoredToneProfile,
} from './tone-control';

const context: ListeningContext = {
  track: 'Jet City Woman',
  album: 'Empire',
  artist: 'Queensrÿche',
  genre: 'Progressive Metal',
};

describe('three-band tone control', () => {
  it('mantiene Sin EQ como bypass estricto', () => {
    const resolved = resolveToneProfile({
      mode: 'off',
      general: { bass: 3, mid: 2, treble: 1 },
      context,
      profiles: [],
    });
    const recipe = buildToneRecipe(resolved);

    expect(recipe.bypass).toBe(true);
    expect(recipe.preampDb).toBe(0);
    expect(recipe.bands.map((band) => band.gainDb)).toEqual([0, 0, 0]);
  });

  it('representa graves, medios y agudos como tres filtros amplios', () => {
    const recipe = buildToneRecipe({
      source: 'general',
      label: 'Ajuste general',
      curve: { bass: 2, mid: -1.5, treble: 3 },
    });

    expect(recipe.bands.map((band) => band.frequency)).toEqual([120, 1000, 6000]);
    expect(recipe.bands.map((band) => band.gainDb)).toEqual([2, -1.5, 3]);
    expect(recipe.dynamicEnabled).toBe(false);
    expect(recipe.preampDb).toBe(-3.5);
  });

  it('ofrece tres coberturas coherentes sin cambiar la curva del usuario', () => {
    const resolved = {
      source: 'general' as const,
      label: 'Ajuste general',
      curve: { bass: 2, mid: -1, treble: 3 },
    };
    expect(buildToneRecipe(resolved, 'hifi').bands.map((band) => band.frequency)).toEqual([100, 1000, 10_000]);
    expect(buildToneRecipe(resolved, 'wide').bands.map((band) => band.frequency)).toEqual([120, 1000, 6000]);
    expect(buildToneRecipe(resolved, 'audible').bands.map((band) => band.frequency)).toEqual([150, 1200, 4000]);
    expect(Object.keys(TONE_TUNINGS)).toEqual(['hifi', 'wide', 'audible']);
    expect(buildToneRecipe(resolved, 'audible').bands.map((band) => band.gainDb)).toEqual([2, -1, 3]);
  });

  it('resuelve canción antes que álbum, artista, género y general', () => {
    const profiles: StoredToneProfile[] = [
      profile('genre', context.genre, 1),
      profile('artist', context.artist, 2),
      profile('album', context.album, 3),
      profile('track', context.track, 4),
    ];

    const resolved = resolveToneProfile({
      mode: 'contextual',
      general: { bass: 0.5, mid: 0.5, treble: 0.5 },
      context,
      profiles,
    });

    expect(resolved.source).toBe('track');
    expect(resolved.curve.bass).toBe(4);
  });

  it('usa el general cuando no hay coincidencia contextual', () => {
    const resolved = resolveToneProfile({
      mode: 'contextual',
      general: { bass: 1, mid: 0, treble: -1 },
      context,
      profiles: [],
    });

    expect(resolved.source).toBe('general');
    expect(resolved.label).toMatch(/sin coincidencia/i);
  });

  it('normaliza claves y limita ganancias a pasos de medio decibel', () => {
    expect(profileKey('artist', '  QUEENSRŸCHE  ')).toBe(profileKey('artist', 'queensrÿche'));
    const recipe = buildToneRecipe({
      source: 'artist',
      label: 'Artista',
      curve: { bass: 9, mid: 0.26, treble: -12 },
    });
    expect(recipe.bands.map((band) => band.gainDb)).toEqual([6, 0.5, -6]);
  });

  it('permite un rango extremo solo cuando se solicita expresamente', () => {
    const resolved = {
      source: 'general' as const,
      label: 'Diagnóstico',
      curve: { bass: 12, mid: 0, treble: -12 },
    };
    expect(buildToneRecipe(resolved).bands.map((band) => band.gainDb)).toEqual([6, 0, -6]);
    const diagnostic = buildToneRecipe(resolved, 'audible', 12);
    expect(diagnostic.bands.map((band) => band.gainDb)).toEqual([12, 0, -12]);
    expect(diagnostic.preampDb).toBe(-12.5);
  });
});

function profile(scope: StoredToneProfile['scope'], label: string, bass: number): StoredToneProfile {
  return {
    scope,
    key: profileKey(scope, label),
    label,
    curve: { bass, mid: 0, treble: 0 },
    updatedAt: '2026-09-07T00:00:00.000Z',
  };
}
