import type { AudioRecipe, AuditionSegment, ComparisonTrims } from './model';

export async function calibrateComparison(
  sourceBuffer: AudioBuffer,
  recipe: AudioRecipe,
  segment: AuditionSegment,
): Promise<ComparisonTrims> {
  if (recipe.bypass) {
    return { dryDb: 0, wetDb: 0, measuredDeltaDb: 0, method: 'segment-rms-static-chain' };
  }

  const sampleRate = sourceBuffer.sampleRate;
  const duration = Math.min(segment.durationSeconds, sourceBuffer.duration - segment.startSeconds);
  const frameCount = Math.max(1, Math.ceil(duration * sampleRate));
  const context = new OfflineAudioContext(sourceBuffer.numberOfChannels, frameCount, sampleRate);
  const source = context.createBufferSource();
  source.buffer = sourceBuffer;
  let previous: AudioNode = source;

  for (const [index, band] of recipe.bands.entries()) {
    const filter = context.createBiquadFilter();
    filter.type = index === 0 ? 'lowshelf' : index === recipe.bands.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = band.frequency;
    filter.Q.value = filter.type === 'peaking' ? 0.85 : 0.7;
    filter.gain.value = band.gainDb;
    previous.connect(filter);
    previous = filter;
  }

  const preamp = context.createGain();
  preamp.gain.value = dbToGain(recipe.preampDb);
  previous.connect(preamp);
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -3;
  compressor.knee.value = 2;
  compressor.ratio.value = 10;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.12;
  preamp.connect(compressor).connect(context.destination);
  source.start(0, segment.startSeconds, duration);

  const rendered = await context.startRendering();
  const dryDb = measureRmsDb(sourceBuffer, segment.startSeconds, duration) + recipe.preampDb;
  const wetDb = measureRmsDb(rendered, 0, duration);
  const measuredDeltaDb = round(wetDb - dryDb);
  const correction = clamp(-measuredDeltaDb, -6, 6);

  // Para conservar headroom nunca se amplifica una ruta: se atenúa la más fuerte.
  return {
    dryDb: correction > 0 ? -correction : 0,
    wetDb: correction < 0 ? correction : 0,
    measuredDeltaDb,
    method: 'segment-rms-static-chain',
  };
}

function measureRmsDb(buffer: AudioBuffer, startSeconds: number, durationSeconds: number): number {
  const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
  const end = Math.min(buffer.length, Math.ceil((startSeconds + durationSeconds) * buffer.sampleRate));
  let sumSquares = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let index = start; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      sumSquares += sample * sample;
      count += 1;
    }
  }
  const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
