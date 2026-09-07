import { analyzeAudioBuffer } from './analysis';
import { AudioEngine } from './audio-engine';
import { createTechnicalDemo } from './demo-audio';
import type { AudioRecipe, ProfileInference, ProfileSelection, TrackAnalysis } from './model';
import { buildRecipe, inferProfiles, PROFILES } from './profiles';

const fileInput = element<HTMLInputElement>('audio-file');
const loadDemoButton = element<HTMLButtonElement>('load-demo');
const playButton = element<HTMLButtonElement>('play');
const seekInput = element<HTMLInputElement>('seek');
const profileSelect = element<HTMLSelectElement>('profile');
const tagsInput = element<HTMLInputElement>('tags');
const intensityInput = element<HTMLInputElement>('intensity');
const intensityValue = element<HTMLOutputElement>('intensity-value');
const adaptationInput = element<HTMLInputElement>('track-adaptation');
const dynamicInput = element<HTMLInputElement>('dynamic-eq');
const exportButton = element<HTMLButtonElement>('export-recipe');
const abButton = element<HTMLButtonElement>('ab-toggle');
const canvas = element<HTMLCanvasElement>('curve');
const context2d = canvas.getContext('2d');

if (!context2d) {
  throw new Error('Canvas 2D no está disponible.');
}

const audio = new Audio();
audio.preload = 'metadata';
const engine = new AudioEngine(audio);
engine.prepare();
let analysis: TrackAnalysis | null = null;
let inference: ProfileInference = inferProfiles([], null);
let recipe: AudioRecipe = createRecipe();
let objectUrl: string | null = null;
let currentFileName = '';

engine.applyRecipe(recipe);
renderAll();
requestAnimationFrame(renderRealtime);

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) {
    void loadFile(file);
  }
});

loadDemoButton.addEventListener('click', () => {
  void loadFile(createTechnicalDemo());
});

playButton.addEventListener('click', async () => {
  try {
    await engine.resume();
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  } catch (error) {
    setStatus(`No fue posible reproducir: ${asMessage(error)}`, true);
  }
});

seekInput.addEventListener('input', () => {
  if (Number.isFinite(audio.duration)) {
    audio.currentTime = (Number(seekInput.value) / 1000) * audio.duration;
  }
});

for (const input of [profileSelect, tagsInput, intensityInput, adaptationInput, dynamicInput]) {
  input.addEventListener('input', () => {
    recomputeRecipe();
  });
}

abButton.addEventListener('click', () => {
  if (recipe.bypass) {
    return;
  }
  engine.selectOriginal(!engine.isOriginalSelected());
  renderAbState();
});

exportButton.addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    fileName: currentFileName,
    tags: parseTags(),
    recipe,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeBaseName(currentFileName || 'pista')}.hirmos-audio-recipe.json`;
  link.click();
  URL.revokeObjectURL(url);
});

audio.addEventListener('play', renderPlayState);
audio.addEventListener('pause', renderPlayState);
audio.addEventListener('ended', renderPlayState);
audio.addEventListener('durationchange', renderTimeline);
audio.addEventListener('timeupdate', renderTimeline);
audio.addEventListener('error', () => {
  setStatus('El navegador no pudo decodificar este archivo.', true);
});

window.addEventListener('beforeunload', () => {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }
  engine.dispose();
});

async function loadFile(file: File): Promise<void> {
  playButton.disabled = true;
  seekInput.disabled = true;
  exportButton.disabled = true;
  setStatus(`Analizando “${file.name}”…`);
  audio.pause();
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  audio.load();
  currentFileName = file.name;
  element('track-name').textContent = file.name;
  element('track-detail').textContent = `${formatBytes(file.size)} · análisis local`;

  try {
    const decodingContext = new AudioContext();
    const decoded = await decodingContext.decodeAudioData(await file.arrayBuffer());
    analysis = analyzeAudioBuffer(decoded);
    await decodingContext.close();
    playButton.disabled = false;
    seekInput.disabled = false;
    exportButton.disabled = false;
    recomputeRecipe();
    engine.selectOriginal(true);
    renderAll();
    setStatus('Análisis listo. Empieza por Original y compara sin mover el volumen.');
  } catch (error) {
    analysis = null;
    recomputeRecipe();
    setStatus(`No fue posible analizar la pista: ${asMessage(error)}`, true);
  }
}

function recomputeRecipe(): void {
  inference = inferProfiles(parseTags(), analysis);
  recipe = createRecipe();
  engine.applyRecipe(recipe);
  if (recipe.bypass) {
    engine.selectOriginal(true);
  }
  renderAll();
}

function createRecipe(): AudioRecipe {
  return buildRecipe({
    selection: profileSelect.value as ProfileSelection,
    inference,
    analysis,
    intensityPercent: Number(intensityInput.value),
    adaptationEnabled: adaptationInput.checked,
    dynamicEnabled: dynamicInput.checked,
  });
}

function renderAll(): void {
  const diagnostic = recipe.selection === 'diagnostic';
  const controlsLocked = recipe.bypass || diagnostic;
  intensityValue.value = diagnostic ? 'fija' : `${intensityInput.value} %`;
  element('recipe-version').textContent = recipe.engineVersion.split('/')[1] ?? recipe.engineVersion;
  element('headroom').textContent = `Preamp ${formatSigned(recipe.preampDb)} dB`;
  element('flat-note').hidden = !recipe.bypass;
  element('diagnostic-note').hidden = !diagnostic;
  intensityInput.disabled = controlsLocked;
  adaptationInput.disabled = controlsLocked;
  dynamicInput.disabled = controlsLocked;
  abButton.disabled = playButton.disabled || recipe.bypass;
  renderMetrics();
  renderAffinities();
  renderBands();
  renderAbState();
}

function renderMetrics(): void {
  const container = element('metrics');
  if (!analysis) {
    container.innerHTML = '<p class="empty">Carga una pista para analizarla.</p>';
    return;
  }
  const clippedPercent = analysis.clippedRatio * 100;
  const metrics = [
    ['Pico de muestra', `${analysis.samplePeakDbfs.toFixed(1)} dBFS`, analysis.samplePeakDbfs > -0.2 ? 'Atención' : ''],
    ['RMS', `${analysis.rmsDbfs.toFixed(1)} dBFS`, 'Descriptivo'],
    ['Crest factor', `${analysis.crestDb.toFixed(1)} dB`, analysis.crestDb < 7 ? 'Muy densa' : ''],
    ['Muestras al límite', clippedPercent < 0.001 ? '< 0.001 %' : `${clippedPercent.toFixed(3)} %`, analysis.clippedSamples > 0 ? 'Revisar' : ''],
    ['Impulsos candidatos', String(analysis.impulseCandidates), 'Heurístico'],
    ['Formato decodificado', `${Math.round(analysis.sampleRate / 1000)} kHz · ${analysis.channels} ch`, formatTime(analysis.durationSeconds)],
  ];
  container.innerHTML = metrics.map(([label, value, note]) => `
    <article class="metric">
      <span>${escapeHtml(label ?? '')}</span>
      <strong>${escapeHtml(value ?? '')}</strong>
      <small>${escapeHtml(note ?? '')}</small>
    </article>
  `).join('');
}

function renderAffinities(): void {
  const container = element('affinities');
  container.innerHTML = inference.affinities.map((affinity) => `
    <div class="affinity-row">
      <span>${PROFILES[affinity.profileId].label}</span>
      <div><i style="width: ${Math.max(2, affinity.score * 100).toFixed(1)}%"></i></div>
      <strong>${Math.round(affinity.score * 100)} %</strong>
    </div>
  `).join('');
  element('evidence').innerHTML = inference.evidence
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');
}

function renderBands(): void {
  element('band-values').innerHTML = recipe.bands.map((band) => `
    <div class="band">
      <span>${formatFrequency(band.frequency)}</span>
      <strong class="${band.gainDb > 0.05 ? 'positive' : band.gainDb < -0.05 ? 'negative' : ''}">
        ${formatSigned(band.gainDb)} dB
      </strong>
      <small>${band.adaptationDb < -0.05 ? `${formatSigned(band.adaptationDb)} adapt.` : 'perfil'}</small>
    </div>
  `).join('');
}

function renderDynamicValues(): void {
  const reductions = engine.getDynamicReductions();
  const container = element('dynamic-values');
  if (recipe.bypass || !recipe.dynamicEnabled) {
    container.innerHTML = '<span class="inactive">Desactivada</span>';
    return;
  }
  container.innerHTML = reductions.map((item) => `
    <span>${escapeHtml(item.label)} <strong>${item.reductionDb.toFixed(1)} dB</strong></span>
  `).join('');
}

function renderAbState(): void {
  const original = recipe.bypass || engine.isOriginalSelected();
  element('ab-state').textContent = original ? 'Original' : 'Procesada';
  abButton.setAttribute('aria-pressed', String(original));
  abButton.classList.toggle('ab-toggle--original', original);
}

function renderPlayState(): void {
  const playing = !audio.paused && !audio.ended;
  playButton.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  playButton.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>';
}

function renderTimeline(): void {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  element('current-time').textContent = formatTime(current);
  element('duration').textContent = formatTime(duration);
  seekInput.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0';
}

function renderRealtime(): void {
  drawVisualization();
  renderDynamicValues();
  requestAnimationFrame(renderRealtime);
}

function drawVisualization(): void {
  if (!context2d) {
    return;
  }
  const box = canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(320, Math.round(box.width * ratio));
  const height = Math.max(220, Math.round(box.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = context2d;
  const padding = { top: 22 * ratio, right: 18 * ratio, bottom: 30 * ratio, left: 42 * ratio };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = ratio;
  ctx.font = `${10 * ratio}px ui-sans-serif, system-ui`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const gain of [-6, -3, 0, 3, 6]) {
    const y = padding.top + ((6 - gain) / 12) * plotHeight;
    ctx.strokeStyle = gain === 0 ? '#383d47' : '#20242c';
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = '#737b89';
    ctx.fillText(`${gain > 0 ? '+' : ''}${gain}`, padding.left - 8 * ratio, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const frequency of [50, 100, 250, 1000, 4000, 10_000, 18_000]) {
    const x = frequencyX(frequency, padding.left, plotWidth);
    ctx.strokeStyle = '#181c23';
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
    ctx.fillStyle = '#737b89';
    ctx.fillText(formatFrequency(frequency), x, height - padding.bottom + 9 * ratio);
  }

  const liveSpectrum = engine.getOutputSpectrum();
  if (liveSpectrum) {
    ctx.beginPath();
    for (let index = 1; index < liveSpectrum.length; index += 2) {
      const frequency = (index * engine.getSampleRate()) / (liveSpectrum.length * 2);
      if (frequency < 25 || frequency > 18_000) {
        continue;
      }
      const db = Math.max(-100, Math.min(-15, liveSpectrum[index] ?? -100));
      const x = frequencyX(frequency, padding.left, plotWidth);
      const y = padding.top + ((-15 - db) / 85) * plotHeight;
      if (index <= 2) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(125, 139, 161, 0.22)';
    ctx.lineWidth = ratio;
    ctx.stroke();
  }

  const response = engine.getResponseCurve();
  ctx.beginPath();
  for (let index = 0; index < response.frequencies.length; index += 1) {
    const x = frequencyX(response.frequencies[index] ?? 25, padding.left, plotWidth);
    const gain = Math.max(-6, Math.min(6, response.gainsDb[index] ?? 0));
    const y = padding.top + ((6 - gain) / 12) * plotHeight;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = recipe.bypass || engine.isOriginalSelected() ? '#8d96a5' : '#f2b657';
  ctx.lineWidth = 2.4 * ratio;
  ctx.stroke();
}

function parseTags(): string[] {
  return tagsInput.value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function setStatus(message: string, error = false): void {
  const status = element('status');
  status.textContent = message;
  status.classList.toggle('status--error', error);
}

function frequencyX(frequency: number, left: number, width: number): number {
  return left + (Math.log(frequency / 25) / Math.log(18_000 / 25)) * width;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatFrequency(frequency: number): string {
  return frequency >= 1000 ? `${Number((frequency / 1000).toFixed(frequency >= 10_000 ? 0 : 1))}k` : String(frequency);
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeBaseName(value: string): string {
  return value.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'pista';
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Falta el elemento #${id}.`);
  return found as T;
}
