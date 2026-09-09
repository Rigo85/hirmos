import type { AudioRecipe, DynamicRule } from './model';

const RESPONSE_POINTS = 180;

interface DynamicBandState {
  filter: BiquadFilterNode;
  rule: DynamicRule;
  reductionDb: number;
}

export class AudioEngine {
  readonly audio: HTMLAudioElement;

  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private staticFilters: BiquadFilterNode[] = [];
  private dynamicBands: DynamicBandState[] = [];
  private dryTrim: GainNode | null = null;
  private drySelector: GainNode | null = null;
  private wetPreamp: GainNode | null = null;
  private wetSelector: GainNode | null = null;
  private safetyCompressor: DynamicsCompressorNode | null = null;
  private spectrumData: Float32Array<ArrayBuffer> | null = null;
  private timer: number | null = null;
  private recipe: AudioRecipe | null = null;
  private originalSelected = false;
  private comparisonDryOffsetDb = 0;
  private comparisonWetOffsetDb = 0;

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
  }

  prepare(): void {
    this.ensureGraph();
  }

  async resume(): Promise<void> {
    this.ensureGraph();
    if (this.context?.state === 'suspended') {
      await this.context.resume();
    }
  }

  applyRecipe(recipe: AudioRecipe): void {
    this.recipe = recipe;
    const context = this.context;
    if (!context) {
      return;
    }
    const now = context.currentTime;
    if (this.safetyCompressor) {
      const manualTone = recipe.engineVersion.startsWith('hirmos-tone-lab/');
      setAudioParam(this.safetyCompressor.threshold, manualTone ? 0 : -3, context, now, 0.02);
      setAudioParam(this.safetyCompressor.knee, manualTone ? 0 : 2, context, now, 0.02);
    }
    this.staticFilters.forEach((filter, index) => {
      const band = recipe.bands[index];
      const type = index === 0 ? 'lowshelf' : index === recipe.bands.length - 1 ? 'highshelf' : 'peaking';
      filter.type = type;
      setAudioParam(filter.frequency, band?.frequency ?? 1000, context, now, 0.025);
      setAudioParam(filter.Q, type === 'peaking' ? 0.85 : 0.7, context, now, 0.025);
      setAudioParam(filter.gain, band?.gainDb ?? 0, context, now, 0.035);
    });
    this.applyComparisonTrims(now);
    this.configureDynamicBands(recipe.dynamicRules);
    this.applyRoute();
  }

  setComparisonTrims(dryOffsetDb: number, wetOffsetDb: number): void {
    this.comparisonDryOffsetDb = dryOffsetDb;
    this.comparisonWetOffsetDb = wetOffsetDb;
    if (this.context) this.applyComparisonTrims(this.context.currentTime);
  }

  selectOriginal(selected: boolean): void {
    this.originalSelected = selected;
    this.applyRoute();
  }

  isOriginalSelected(): boolean {
    return this.originalSelected;
  }

  getDynamicReductions(): ReadonlyArray<{ label: string; reductionDb: number }> {
    return this.dynamicBands.map((band) => ({
      label: band.rule.label,
      reductionDb: band.reductionDb,
    }));
  }

  getResponseCurve(): { frequencies: Float32Array; gainsDb: Float32Array } {
    const frequencies = logarithmicFrequencies(25, 18_000, RESPONSE_POINTS);
    const totalGain = new Float32Array(RESPONSE_POINTS);
    if (!this.context || this.originalSelected || this.recipe?.bypass) {
      return { frequencies, gainsDb: totalGain };
    }
    const magnitudes = new Float32Array(new ArrayBuffer(RESPONSE_POINTS * Float32Array.BYTES_PER_ELEMENT));
    const phases = new Float32Array(new ArrayBuffer(RESPONSE_POINTS * Float32Array.BYTES_PER_ELEMENT));
    for (const filter of [...this.staticFilters, ...this.dynamicBands.map((band) => band.filter)]) {
      filter.getFrequencyResponse(frequencies, magnitudes, phases);
      for (let index = 0; index < totalGain.length; index += 1) {
        const magnitude = magnitudes[index] ?? 1;
        totalGain[index] = (totalGain[index] ?? 0) + 20 * Math.log10(Math.max(0.000001, magnitude));
      }
    }
    return { frequencies, gainsDb: totalGain };
  }

  getOutputSpectrum(): Float32Array | null {
    if (!this.outputAnalyser) {
      return null;
    }
    const values = new Float32Array(this.outputAnalyser.frequencyBinCount);
    this.outputAnalyser.getFloatFrequencyData(values);
    return values;
  }

  getSampleRate(): number {
    return this.context?.sampleRate ?? 44_100;
  }

  dispose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    void this.context?.close();
    this.context = null;
  }

  private ensureGraph(): void {
    if (this.context) {
      return;
    }
    const context = new AudioContext({ latencyHint: 'playback' });
    const source = context.createMediaElementSource(this.audio);
    const inputAnalyser = context.createAnalyser();
    inputAnalyser.fftSize = 4096;
    inputAnalyser.smoothingTimeConstant = 0.72;
    const outputAnalyser = context.createAnalyser();
    outputAnalyser.fftSize = 2048;
    outputAnalyser.smoothingTimeConstant = 0.78;
    const dryTrim = context.createGain();
    const drySelector = context.createGain();
    const wetPreamp = context.createGain();
    const wetSelector = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -3;
    compressor.knee.value = 2;
    compressor.ratio.value = 10;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;

    const staticFilters = Array.from({ length: 5 }, () => context.createBiquadFilter());
    const dynamicFilters = Array.from({ length: 3 }, () => context.createBiquadFilter());
    source.connect(dryTrim).connect(drySelector).connect(outputAnalyser);
    source.connect(inputAnalyser);
    connectSerial(inputAnalyser, [...staticFilters, ...dynamicFilters, wetPreamp, compressor, wetSelector, outputAnalyser]);
    outputAnalyser.connect(context.destination);

    this.context = context;
    this.source = source;
    this.inputAnalyser = inputAnalyser;
    this.outputAnalyser = outputAnalyser;
    this.staticFilters = staticFilters;
    this.dynamicBands = dynamicFilters.map((filter, index) => ({
      filter,
      rule: fallbackRule(index),
      reductionDb: 0,
    }));
    this.dryTrim = dryTrim;
    this.drySelector = drySelector;
    this.wetPreamp = wetPreamp;
    this.wetSelector = wetSelector;
    this.safetyCompressor = compressor;
    this.spectrumData = new Float32Array(inputAnalyser.frequencyBinCount);
    this.timer = window.setInterval(() => this.updateDynamicEq(), 80);
    if (this.recipe) {
      this.applyRecipe(this.recipe);
    } else {
      this.applyRoute();
    }
  }

  private configureDynamicBands(rules: readonly DynamicRule[]): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const now = context.currentTime;
    this.dynamicBands.forEach((band, index) => {
      const rule = rules[index] ?? { ...fallbackRule(index), maxReductionDb: 0 };
      band.rule = rule;
      band.reductionDb = 0;
      band.filter.type = 'peaking';
      setAudioParam(band.filter.frequency, rule.frequency, context, now, 0.02);
      setAudioParam(band.filter.Q, rule.q, context, now, 0.02);
      setAudioParam(band.filter.gain, 0, context, now, 0.02);
    });
  }

  private updateDynamicEq(): void {
    const analyser = this.inputAnalyser;
    const data = this.spectrumData;
    const context = this.context;
    if (!analyser || !data || !context || !this.recipe || this.recipe.bypass || !this.recipe.dynamicEnabled) {
      return;
    }
    analyser.getFloatFrequencyData(data);
    const broadband = averagePowerDb(data, context.sampleRate, analyser.fftSize, 55, 14_000);
    for (const band of this.dynamicBands) {
      const lower = band.rule.frequency / Math.pow(2, 0.22);
      const upper = band.rule.frequency * Math.pow(2, 0.22);
      const bandDb = averagePowerDb(data, context.sampleRate, analyser.fftSize, lower, upper);
      const excess = bandDb - broadband - band.rule.thresholdRelativeDb;
      const target = excess > 0
        ? -Math.min(band.rule.maxReductionDb, excess * 0.45)
        : 0;
      const movingDown = target < band.reductionDb;
      const timeMs = movingDown ? band.rule.attackMs : band.rule.releaseMs;
      const smoothing = 1 - Math.exp(-80 / Math.max(1, timeMs));
      band.reductionDb += (target - band.reductionDb) * smoothing;
      band.filter.gain.setTargetAtTime(band.reductionDb, context.currentTime, Math.max(0.006, timeMs / 3000));
    }
  }

  private applyRoute(): void {
    const context = this.context;
    if (!context || !this.drySelector || !this.wetSelector) {
      return;
    }
    const original = this.originalSelected || this.recipe?.bypass !== false;
    const now = context.currentTime;
    this.drySelector.gain.cancelScheduledValues(now);
    this.wetSelector.gain.cancelScheduledValues(now);
    setAudioParam(this.drySelector.gain, original ? 1 : 0, context, now, 0.008);
    setAudioParam(this.wetSelector.gain, original ? 0 : 1, context, now, 0.008);
  }

  private applyComparisonTrims(now: number): void {
    const context = this.context;
    const recipe = this.recipe;
    if (!context || !recipe) return;
    if (this.dryTrim) {
      setAudioParam(this.dryTrim.gain, dbToGain(recipe.preampDb + this.comparisonDryOffsetDb), context, now, 0.025);
    }
    if (this.wetPreamp) {
      setAudioParam(this.wetPreamp.gain, dbToGain(recipe.preampDb + this.comparisonWetOffsetDb), context, now, 0.025);
    }
  }
}

function connectSerial(first: AudioNode, remaining: readonly AudioNode[]): void {
  let previous = first;
  for (const node of remaining) {
    previous.connect(node);
    previous = node;
  }
}

function averagePowerDb(
  data: Float32Array,
  sampleRate: number,
  fftSize: number,
  lowerFrequency: number,
  upperFrequency: number,
): number {
  const binWidth = sampleRate / fftSize;
  const first = Math.max(1, Math.floor(lowerFrequency / binWidth));
  const last = Math.min(data.length - 1, Math.ceil(upperFrequency / binWidth));
  let power = 0;
  let count = 0;
  for (let index = first; index <= last; index += 1) {
    const db = data[index] ?? -120;
    if (Number.isFinite(db)) {
      power += 10 ** (db / 10);
      count += 1;
    }
  }
  return count === 0 ? -120 : 10 * Math.log10(Math.max(1e-12, power / count));
}

function logarithmicFrequencies(minimum: number, maximum: number, count: number): Float32Array<ArrayBuffer> {
  const values = new Float32Array(new ArrayBuffer(count * Float32Array.BYTES_PER_ELEMENT));
  const ratio = maximum / minimum;
  for (let index = 0; index < count; index += 1) {
    values[index] = minimum * ratio ** (index / (count - 1));
  }
  return values;
}

function fallbackRule(index: number): DynamicRule {
  const definitions = [
    { id: 'boom', label: 'Grave', frequency: 125 },
    { id: 'harshness', label: 'Aspereza', frequency: 3500 },
    { id: 'brightness', label: 'Brillo', frequency: 8000 },
  ];
  const definition = definitions[index] ?? definitions[0];
  return {
    id: definition?.id ?? 'inactive',
    label: definition?.label ?? 'Inactiva',
    frequency: definition?.frequency ?? 1000,
    q: 1,
    thresholdRelativeDb: 100,
    maxReductionDb: 0,
    attackMs: 100,
    releaseMs: 400,
  };
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function setAudioParam(
  parameter: AudioParam,
  value: number,
  context: AudioContext,
  now: number,
  timeConstant: number,
): void {
  if (context.state === 'running') {
    parameter.setTargetAtTime(value, now, timeConstant);
  } else {
    parameter.value = value;
  }
}
