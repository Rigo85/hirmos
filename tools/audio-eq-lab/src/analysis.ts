import {
  ANALYSIS_FREQUENCIES,
  type AuditionSegment,
  type SpectrumBand,
  type TrackAnalysis,
} from './model';

const MIN_DB = -120;
const ANALYSIS_WINDOWS = 72;
const WINDOW_SIZE = 4096;
const ENERGY_BLOCK_SECONDS = 0.5;
const AUDITION_SECONDS = 18;

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
  const energyBlockSize = Math.max(1, Math.round(sampleRate * ENERGY_BLOCK_SECONDS));
  const energyBlocks: number[] = [];
  let energyBlockSum = 0;
  let energyBlockSamples = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    let mono = 0;
    let frameSquareSum = 0;
    for (const channel of usableChannels) {
      const sample = channel[index] ?? 0;
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      sumSquares += sample * sample;
      frameSquareSum += sample * sample;
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
    energyBlockSum += frameSquareSum / usableChannels.length;
    energyBlockSamples += 1;
    if (energyBlockSamples === energyBlockSize || index === sampleCount - 1) {
      energyBlocks.push(energyBlockSum / energyBlockSamples);
      energyBlockSum = 0;
      energyBlockSamples = 0;
    }
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
    auditionSegments: selectAuditionSegments(energyBlocks, sampleCount / sampleRate),
  };
}

function selectAuditionSegments(blockPowers: readonly number[], durationSeconds: number): AuditionSegment[] {
  const segmentDuration = Math.min(AUDITION_SECONDS, durationSeconds);
  if (blockPowers.length === 0 || segmentDuration <= 0) {
    return [];
  }
  const blocksPerSegment = Math.max(1, Math.round(segmentDuration / ENERGY_BLOCK_SECONDS));
  const lastStart = Math.max(0, blockPowers.length - blocksPerSegment);
  const candidates: Array<{ startBlock: number; rmsDbfs: number; variation: number }> = [];
  const step = Math.max(1, Math.round(2 / ENERGY_BLOCK_SECONDS));

  for (let startBlock = 0; startBlock <= lastStart; startBlock += step) {
    const values = blockPowers.slice(startBlock, startBlock + blocksPerSegment);
    const meanPower = values.reduce((sum, value) => sum + value, 0) / values.length;
    const blockDbs = values.map(powerToDb);
    const meanDb = blockDbs.reduce((sum, value) => sum + value, 0) / blockDbs.length;
    const variation = Math.sqrt(blockDbs.reduce((sum, value) => sum + (value - meanDb) ** 2, 0) / blockDbs.length);
    candidates.push({ startBlock, rmsDbfs: powerToDb(meanPower), variation });
  }

  const byEnergy = [...candidates].sort((left, right) => right.rmsDbfs - left.rmsDbfs);
  const sortedLevels = [...candidates].sort((left, right) => left.rmsDbfs - right.rmsDbfs);
  const targetLevel = sortedLevels[Math.floor((sortedLevels.length - 1) * 0.7)]?.rmsDbfs ?? byEnergy[0]?.rmsDbfs ?? MIN_DB;
  const byRepresentativeLevel = [...candidates].sort(
    (left, right) => Math.abs(left.rmsDbfs - targetLevel) - Math.abs(right.rmsDbfs - targetLevel),
  );
  const byVariation = [...candidates].sort((left, right) => right.variation - left.variation);
  const choices = [
    { candidates: byRepresentativeLevel, id: 'representative', label: 'Representativo' },
    { candidates: byEnergy, id: 'energetic', label: 'Enérgico' },
    { candidates: byVariation, id: 'dynamic', label: 'Con más contraste' },
  ];
  const selected: AuditionSegment[] = [];

  for (const choice of choices) {
    const candidate = choice.candidates.find((item) => {
      const startSeconds = item.startBlock * ENERGY_BLOCK_SECONDS;
      return !selected.some((selectedItem) => Math.abs(selectedItem.startSeconds - startSeconds) < segmentDuration * 0.65);
    });
    if (!candidate) continue;
    const startSeconds = candidate.startBlock * ENERGY_BLOCK_SECONDS;
    selected.push({
      id: choice.id,
      label: choice.label,
      startSeconds: round(Math.min(startSeconds, Math.max(0, durationSeconds - segmentDuration))),
      durationSeconds: round(segmentDuration),
      rmsDbfs: round(candidate.rmsDbfs),
    });
  }

  return selected.length > 0 ? selected : [{
    id: 'full',
    label: 'Pista completa',
    startSeconds: 0,
    durationSeconds: round(segmentDuration),
    rmsDbfs: round(powerToDb(blockPowers.reduce((sum, value) => sum + value, 0) / blockPowers.length)),
  }];
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
