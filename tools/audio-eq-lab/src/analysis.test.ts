import { describe, expect, it } from 'vitest';
import { analyzeSamples } from './analysis';

describe('analyzeSamples', () => {
  it('identifica la banda dominante de una señal tonal', () => {
    const sampleRate = 44_100;
    const samples = sineWave(125, 0.5, sampleRate, 2);
    const analysis = analyzeSamples([samples], sampleRate);
    const strongest = [...analysis.spectrum].sort((left, right) => right.db - left.db)[0];

    expect(strongest?.frequency).toBe(125);
    expect(analysis.samplePeakDbfs).toBeCloseTo(-6.02, 1);
    expect(analysis.rmsDbfs).toBeCloseTo(-9.03, 1);
    expect(analysis.crestDb).toBeCloseTo(3.01, 1);
  });

  it('cuenta muestras que alcanzan el límite sin llamarlas true peak', () => {
    const samples = new Float32Array([0, 1, -1, 0.4, 0]);
    const analysis = analyzeSamples([samples], 5);

    expect(analysis.clippedSamples).toBe(2);
    expect(analysis.clippedRatio).toBeCloseTo(0.4);
    expect(analysis.samplePeakDbfs).toBe(0);
  });

  it('rechaza una entrada sin muestras', () => {
    expect(() => analyzeSamples([], 44_100)).toThrow(/muestras analizables/i);
  });
});

function sineWave(frequency: number, amplitude: number, sampleRate: number, seconds: number): Float32Array {
  const samples = new Float32Array(sampleRate * seconds);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return samples;
}
