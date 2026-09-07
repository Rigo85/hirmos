import { ANALYSIS_FREQUENCIES, type SpectrumBand, type TrackAnalysis } from './model';

const MIN_DB = -120;
const ANALYSIS_WINDOWS = 72;
const WINDOW_SIZE = 4096;

export function analyzeAudioBuffer(buffer: AudioBuffer): TrackAnalysis {
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  );
  return analyzeSamples(channels, buffer.sampleRate);
}

export function analyzeSamples(channels: readonly Float32Array[], sampleRate: number): TrackAnalysis {
  const usableChannels = channels.filter((channel) => channel.length > 0);
  const sampleCount = usableChannels.reduce(
    (minimum, channel) => Math.min(minimum, channel.length),
    Number.POSITIVE_INFINITY,
  );
  if (usableChannels.length === 0 || !Number.isFinite(sampleCount) || sampleCount < 2) {
    throw new Error('La pista no contiene muestras analizables.');
  }

  let peak = 0;
  let sumSquares = 0;
  let clippedSamples = 0;
  let impulseCandidates = 0;
  let previousMono = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    let mono = 0;
    for (const channel of usableChannels) {
      const sample = channel[index] ?? 0;
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      sumSquares += sample * sample;
      if (absolute >= 0.999) {
        clippedSamples += 1;
      }
      mono += sample;
    }
    mono /= usableChannels.length;
    if (index > 0 && Math.abs(mono - previousMono) >= 0.78 && Math.abs(mono) >= 0.58) {
      impulseCandidates += 1;
    }
    previousMono = mono;
  }

  const totalSamples = sampleCount * usableChannels.length;
  const rms = Math.sqrt(sumSquares / totalSamples);
  const peakDb = amplitudeToDb(peak);
  const rmsDb = amplitudeToDb(rms);
  const spectrum = analyzeSpectrum(usableChannels, sampleRate, sampleCount);

  return {
    durationSeconds: sampleCount / sampleRate,
    sampleRate,
    channels: usableChannels.length,
    samplePeakDbfs: round(peakDb),
    rmsDbfs: round(rmsDb),
    crestDb: round(peakDb - rmsDb),
    clippedSamples,
    clippedRatio: clippedSamples / totalSamples,
    impulseCandidates,
    spectrum,
  };
}

function analyzeSpectrum(
  channels: readonly Float32Array[],
  sampleRate: number,
  sampleCount: number,
): SpectrumBand[] {
  const windowSize = Math.min(WINDOW_SIZE, previousPowerOfTwo(sampleCount));
  if (windowSize < 64) {
    return ANALYSIS_FREQUENCIES.map((frequency) => ({ frequency, db: MIN_DB, relativeDb: 0 }));
  }
  const windowCount = Math.min(ANALYSIS_WINDOWS, Math.max(1, Math.floor(sampleCount / windowSize)));
  const powers = new Array<number>(ANALYSIS_FREQUENCIES.length).fill(0);
  const frame = new Float32Array(windowSize);

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    const progress = windowCount === 1 ? 0 : windowIndex / (windowCount - 1);
    const start = Math.floor(progress * Math.max(0, sampleCount - windowSize));
    for (let offset = 0; offset < windowSize; offset += 1) {
      let mono = 0;
      for (const channel of channels) {
        mono += channel[start + offset] ?? 0;
      }
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * offset) / (windowSize - 1));
      frame[offset] = (mono / channels.length) * hann;
    }
    ANALYSIS_FREQUENCIES.forEach((frequency, frequencyIndex) => {
      powers[frequencyIndex] = (powers[frequencyIndex] ?? 0) + goertzelPower(frame, sampleRate, frequency);
    });
  }

  const dbValues = powers.map((power) => powerToDb(power / windowCount));
  const medianDb = median(dbValues);
  return ANALYSIS_FREQUENCIES.map((frequency, index) => ({
    frequency,
    db: round(dbValues[index] ?? MIN_DB),
    relativeDb: round((dbValues[index] ?? MIN_DB) - medianDb),
  }));
}

function goertzelPower(samples: Float32Array, sampleRate: number, frequency: number): number {
  if (frequency >= sampleRate / 2) {
    return 0;
  }
  const normalized = frequency / sampleRate;
  const coefficient = 2 * Math.cos(2 * Math.PI * normalized);
  let previous = 0;
  let previousPrevious = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  const rawPower = previousPrevious * previousPrevious
    + previous * previous
    - coefficient * previous * previousPrevious;
  return Math.max(0, rawPower / (samples.length * samples.length));
}

function previousPowerOfTwo(value: number): number {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

function amplitudeToDb(value: number): number {
  return value <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(value));
}

function powerToDb(value: number): number {
  return value <= 0 ? MIN_DB : Math.max(MIN_DB, 10 * Math.log10(value));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
