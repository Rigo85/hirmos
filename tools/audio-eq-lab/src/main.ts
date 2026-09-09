import { AudioEngine } from './audio-engine';
import { createTechnicalDemo } from './demo-audio';
import {
  buildToneRecipe,
  copyCurve,
  NEUTRAL_CURVE,
  profileKey,
  resolveToneProfile,
  sanitizeCurve,
  SCOPE_LABELS,
  TONE_TUNINGS,
  type EqMode,
  type EqScope,
  type ListeningContext,
  type ResolvedToneProfile,
  type StoredToneProfile,
  type ToneBand,
  type ToneCurve,
  type ToneTuningId,
} from './tone-control';

const STORAGE_KEY = 'hirmos-tone-lab-v1';
const MODE_DESCRIPTIONS: Record<EqMode, string> = {
  off: 'Bypass real: la señal original no atraviesa ningún filtro.',
  general: 'Una curva base para toda la música reproducida en este dispositivo.',
  contextual: 'Busca primero canción, luego álbum, artista y género; si no encuentra un ajuste usa el general.',
};
const CONTEXT_LABELS: Record<EqScope, string> = {
  track: 'Nombre de la canción',
  album: 'Nombre del álbum',
  artist: 'Nombre del artista',
  genre: 'Nombre del género principal',
};
const CONTEXT_PLACEHOLDERS: Record<EqScope, string> = {
  track: 'Jet City Woman',
  album: 'Empire',
  artist: 'Queensrÿche',
  genre: 'Progressive Metal',
};
const SAVE_LABELS: Record<EqScope, string> = {
  track: 'Guardar para esta canción',
  album: 'Guardar para este álbum',
  artist: 'Guardar para este artista',
  genre: 'Guardar para este género',
};

interface LabState {
  mode: EqMode;
  tuning: ToneTuningId;
  gainRange: 6 | 12;
  general: ToneCurve;
  context: ListeningContext;
  profiles: StoredToneProfile[];
}

const fileInput = element<HTMLInputElement>('audio-file');
const loadDemoButton = element<HTMLButtonElement>('load-demo');
const playButton = element<HTMLButtonElement>('play');
const seekInput = element<HTMLInputElement>('seek');
const abButton = element<HTMLButtonElement>('ab-toggle');
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
const scopeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-scope]')];
const tuningButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-tuning]')];
const gainRangeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-gain-range]')];
const warmContrastButton = element<HTMLButtonElement>('warm-contrast');
const brightContrastButton = element<HTMLButtonElement>('bright-contrast');
const contextInput = element<HTMLInputElement>('context-value');
const saveContextButton = element<HTMLButtonElement>('save-context');
const deleteContextButton = element<HTMLButtonElement>('delete-context');
const resetButton = element<HTMLButtonElement>('reset-tone');
const sliders: Record<ToneBand, HTMLInputElement> = {
  bass: element<HTMLInputElement>('bass'),
  mid: element<HTMLInputElement>('mid'),
  treble: element<HTMLInputElement>('treble'),
};
const canvas = element<HTMLCanvasElement>('curve');
const context2d = canvas.getContext('2d');

if (!context2d) throw new Error('Canvas 2D no está disponible.');

const audio = new Audio();
audio.preload = 'metadata';
const engine = new AudioEngine(audio);
engine.prepare();
let state = loadState();
let selectedScope: EqScope = 'track';
let previewContext = false;
let draftCurve = copyCurve(state.general);
let diagnosticCurve: ToneCurve | null = null;
let diagnosticPrevious: { mode: EqMode; gainRange: 6 | 12 } | null = null;
let recipe = buildToneRecipe(currentResolved(), state.tuning, state.gainRange);
let objectUrl: string | null = null;

engine.applyRecipe(recipe);
renderAll();
requestAnimationFrame(renderCurveLoop);

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
});

loadDemoButton.addEventListener('click', () => {
  loadFile(createTechnicalDemo());
});

playButton.addEventListener('click', async () => {
  try {
    await engine.resume();
    if (audio.paused) await audio.play();
    else audio.pause();
  } catch (error) {
    setStatus(`No fue posible reproducir: ${asMessage(error)}`, true);
  }
});

seekInput.addEventListener('input', () => {
  if (Number.isFinite(audio.duration)) {
    audio.currentTime = (Number(seekInput.value) / 1000) * audio.duration;
  }
});

abButton.addEventListener('click', () => {
  if (recipe.bypass) return;
  engine.selectOriginal(!engine.isOriginalSelected());
  renderAbState();
});

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    state.mode = button.dataset['mode'] as EqMode;
    diagnosticCurve = null;
    diagnosticPrevious = null;
    previewContext = false;
    persistState();
    applyActiveRecipe(true);
  });
}

for (const button of scopeButtons) {
  button.addEventListener('click', () => {
    selectedScope = button.dataset['scope'] as EqScope;
    contextInput.value = state.context[selectedScope];
    loadContextDraft();
  });
}

for (const button of tuningButtons) {
  button.addEventListener('click', () => {
    state.tuning = button.dataset['tuning'] as ToneTuningId;
    persistState();
    applyActiveRecipe(true);
    setStatus(`${TONE_TUNINGS[state.tuning].label}: conserva tus valores y cambia solamente dónde actúan las bandas.`);
  });
}

for (const button of gainRangeButtons) {
  button.addEventListener('click', () => {
    state.gainRange = Number(button.dataset['gainRange']) === 12 ? 12 : 6;
    diagnosticCurve = null;
    diagnosticPrevious = null;
    persistState();
    applyActiveRecipe(true);
    setStatus(state.gainRange === 12
      ? 'Rango diagnóstico ±12 dB activo. No lo trates todavía como un ajuste musical.'
      : 'Rango normal ±6 dB restaurado.');
  });
}

warmContrastButton.addEventListener('click', () => {
  applyDiagnosticContrast({ bass: 12, mid: 0, treble: -12 }, 'Graves arriba · Agudos abajo');
});

brightContrastButton.addEventListener('click', () => {
  applyDiagnosticContrast({ bass: -12, mid: 0, treble: 12 }, 'Graves abajo · Agudos arriba');
});

contextInput.addEventListener('input', () => {
  state.context[selectedScope] = contextInput.value;
  persistState();
  updateContextActions();
});

contextInput.addEventListener('change', () => {
  loadContextDraft();
});

for (const band of ['bass', 'mid', 'treble'] as const) {
  sliders[band].addEventListener('input', () => {
    const nextValue = Number(sliders[band].value);
    if (diagnosticCurve) {
      diagnosticCurve = sanitizeCurve({ ...diagnosticCurve, [band]: nextValue }, state.gainRange);
    } else if (state.mode === 'general') {
      state.general = sanitizeCurve({ ...state.general, [band]: nextValue }, state.gainRange);
      persistState();
    } else if (state.mode === 'contextual') {
      if (!previewContext) {
        draftCurve = copyCurve(currentResolved().curve);
        previewContext = true;
      }
      draftCurve = sanitizeCurve({ ...draftCurve, [band]: nextValue }, state.gainRange);
    }
    applyActiveRecipe(false);
  });
}

resetButton.addEventListener('click', () => {
  if (state.mode === 'off') return;
  if (diagnosticCurve) {
    if (diagnosticPrevious) {
      state.mode = diagnosticPrevious.mode;
      state.gainRange = diagnosticPrevious.gainRange;
    }
    diagnosticCurve = null;
    diagnosticPrevious = null;
    persistState();
    applyActiveRecipe(true);
    setStatus('Diagnóstico retirado; regresaste a tu ajuste anterior.');
    return;
  }
  if (state.mode === 'general') {
    state.general = copyCurve(NEUTRAL_CURVE);
    persistState();
  } else {
    draftCurve = copyCurve(NEUTRAL_CURVE);
    previewContext = true;
  }
  applyActiveRecipe(false);
});

saveContextButton.addEventListener('click', () => {
  const label = state.context[selectedScope].trim();
  const key = profileKey(selectedScope, label);
  if (!key) {
    setContextStatus(`Escribe el ${CONTEXT_LABELS[selectedScope].toLocaleLowerCase('es')} antes de guardar.`, true);
    contextInput.focus();
    return;
  }
  const profile: StoredToneProfile = {
    scope: selectedScope,
    key,
    label,
    curve: sanitizeCurve(draftCurve, state.gainRange),
    updatedAt: new Date().toISOString(),
  };
  state.profiles = [
    profile,
    ...state.profiles.filter((candidate) => !(candidate.scope === selectedScope && candidate.key === key)),
  ];
  previewContext = false;
  persistState();
  const resolved = resolveStoredContext();
  const shadowed = resolved.source !== selectedScope;
  setContextStatus(shadowed
    ? `Guardado, pero ahora gana ${resolved.label} por ser más específico.`
    : `Guardado y activo para ${SCOPE_LABELS[selectedScope].toLocaleLowerCase('es')} “${label}”.`);
  applyActiveRecipe(false);
});

deleteContextButton.addEventListener('click', () => {
  const key = profileKey(selectedScope, state.context[selectedScope]);
  if (!key) return;
  const before = state.profiles.length;
  state.profiles = state.profiles.filter((profile) => !(profile.scope === selectedScope && profile.key === key));
  if (state.profiles.length === before) return;
  previewContext = false;
  persistState();
  setContextStatus('Ajuste eliminado. Se volvió a resolver usando el siguiente alcance disponible.');
  applyActiveRecipe(false);
});

element('saved-profiles').addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const key = target.dataset['profileKey'];
  const scope = target.dataset['profileScope'] as EqScope | undefined;
  if (!key || !scope) return;
  const profile = state.profiles.find((candidate) => candidate.scope === scope && candidate.key === key);
  if (!profile) return;
  diagnosticCurve = null;
  diagnosticPrevious = null;
  if (target.dataset['action'] === 'delete') {
    state.profiles = state.profiles.filter((candidate) => !(candidate.scope === scope && candidate.key === key));
    previewContext = false;
    persistState();
    applyActiveRecipe(false);
    return;
  }
  state.mode = 'contextual';
  selectedScope = scope;
  state.context[scope] = profile.label;
  contextInput.value = profile.label;
  draftCurve = copyCurve(profile.curve);
  previewContext = true;
  persistState();
  applyActiveRecipe(true);
  element('context-editor').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  engine.dispose();
});

function loadFile(file: File): void {
  audio.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  audio.load();
  const trackName = baseName(file.name);
  state.context.track = trackName;
  persistState();
  if (selectedScope === 'track') contextInput.value = trackName;
  element('track-name').textContent = file.name;
  element('track-detail').textContent = `${formatBytes(file.size)} · archivo local`;
  playButton.disabled = false;
  seekInput.disabled = false;
  previewContext = false;
  engine.selectOriginal(state.mode === 'off');
  applyActiveRecipe(false);
  setStatus(`“${file.name}” está lista. Prueba primero una sola banda en +3 o −3 dB.`);
}

function loadContextDraft(): void {
  const label = state.context[selectedScope];
  const key = profileKey(selectedScope, label);
  const existing = key
    ? state.profiles.find((profile) => profile.scope === selectedScope && profile.key === key)
    : undefined;
  draftCurve = copyCurve(existing?.curve ?? state.general);
  previewContext = true;
  setContextStatus(existing
    ? `Editando el ajuste guardado para ${SCOPE_LABELS[selectedScope].toLocaleLowerCase('es')} “${existing.label}”.`
    : 'Vista previa basada en el ajuste general; todavía no está guardada.');
  applyActiveRecipe(false);
}

function applyDiagnosticContrast(curve: ToneCurve, label: string): void {
  if (!diagnosticCurve) {
    diagnosticPrevious = { mode: state.mode, gainRange: state.gainRange };
  }
  state.mode = 'general';
  state.gainRange = 12;
  diagnosticCurve = sanitizeCurve(curve, 12);
  previewContext = false;
  persistState();
  applyActiveRecipe(true);
  setStatus(`${label}: contraste temporal ±12 dB. Alterna A/B y luego pulsa Restablecer.`);
}

function currentResolved(): ResolvedToneProfile {
  if (diagnosticCurve) {
    return {
      source: 'general',
      label: 'Diagnóstico de contraste · no guardado',
      curve: sanitizeCurve(diagnosticCurve, 12),
    };
  }
  if (state.mode === 'contextual' && previewContext) {
    const label = state.context[selectedScope].trim();
    return {
      source: selectedScope,
      label: `Vista previa · ${SCOPE_LABELS[selectedScope]}${label ? ` · ${label}` : ' sin nombre'}`,
      curve: sanitizeCurve(draftCurve, state.gainRange),
    };
  }
  return resolveStoredContext();
}

function resolveStoredContext(): ResolvedToneProfile {
  return resolveToneProfile({
    mode: state.mode,
    general: state.general,
    context: state.context,
    profiles: state.profiles,
    maxGainDb: state.gainRange,
  });
}

function applyActiveRecipe(resetComparison: boolean): void {
  const resolved = currentResolved();
  recipe = buildToneRecipe(resolved, state.tuning, state.gainRange);
  engine.setComparisonTrims(0, 0);
  engine.applyRecipe(recipe);
  if (recipe.bypass) engine.selectOriginal(true);
  else if (resetComparison) engine.selectOriginal(false);
  renderAll();
}

function renderAll(): void {
  const resolved = currentResolved();
  element('recipe-version').textContent = recipe.engineVersion.split('/')[1] ?? recipe.engineVersion;
  element('mode-description').textContent = MODE_DESCRIPTIONS[state.mode];
  element('context-editor').hidden = state.mode !== 'contextual';
  element('headroom').textContent = `Reserva ${formatSigned(recipe.preampDb)} dB`;
  for (const button of modeButtons) {
    button.setAttribute('aria-checked', String(button.dataset['mode'] === state.mode));
  }
  for (const button of scopeButtons) {
    button.setAttribute('aria-checked', String(button.dataset['scope'] === selectedScope));
  }
  for (const button of tuningButtons) {
    button.setAttribute('aria-checked', String(button.dataset['tuning'] === state.tuning));
  }
  for (const button of gainRangeButtons) {
    button.setAttribute('aria-checked', String(Number(button.dataset['gainRange']) === state.gainRange));
  }
  const tuning = TONE_TUNINGS[state.tuning];
  element('tuning-description').textContent = tuning.description;
  element('bass-frequency').textContent = formatFrequencyLong(tuning.frequencies.bass);
  element('mid-frequency').textContent = formatFrequencyLong(tuning.frequencies.mid);
  element('treble-frequency').textContent = formatFrequencyLong(tuning.frequencies.treble);
  element('range-description').textContent = state.gainRange === 12
    ? '±12 dB · diagnóstico deliberadamente exagerado.'
    : '±6 dB · ajuste normal del laboratorio.';
  element('tone-note').textContent = state.gainRange === 12
    ? 'Diagnóstico ±12 dB: úsalo para confirmar una diferencia inequívoca y después pulsa Restablecer. No es una corrección auditiva ni una propuesta productiva.'
    : 'El rango normal está limitado a ±6 dB. Subir agudos no es una corrección auditiva; aquí solo estamos encontrando una preferencia de escucha.';
  element('context-label').textContent = CONTEXT_LABELS[selectedScope];
  contextInput.placeholder = CONTEXT_PLACEHOLDERS[selectedScope];
  if (contextInput.value !== state.context[selectedScope]) contextInput.value = state.context[selectedScope];
  saveContextButton.textContent = SAVE_LABELS[selectedScope];
  element('active-profile').textContent = resolved.label;
  element('active-values').textContent = curveSummary(resolved.curve);
  renderSliders(resolved.curve);
  renderSavedProfiles();
  updateContextActions();
  renderAbState();
}

function renderSliders(curve: Readonly<ToneCurve>): void {
  const disabled = state.mode === 'off';
  for (const band of ['bass', 'mid', 'treble'] as const) {
    sliders[band].disabled = disabled;
    sliders[band].min = String(-state.gainRange);
    sliders[band].max = String(state.gainRange);
    sliders[band].value = String(curve[band]);
    sliders[band].closest('.tone-control')?.classList.toggle('tone-control--disabled', disabled);
    element(`${band}-value`).textContent = `${formatSigned(curve[band])} dB`;
  }
  resetButton.disabled = disabled;
}

function renderSavedProfiles(): void {
  const container = element('saved-profiles');
  element('saved-count').textContent = `${state.profiles.length} ${state.profiles.length === 1 ? 'ajuste' : 'ajustes'}`;
  if (state.profiles.length === 0) {
    container.innerHTML = '<p class="empty">Todavía no has guardado ajustes para música concreta.</p>';
    return;
  }
  container.innerHTML = state.profiles.map((profile) => `
    <article class="saved-profile">
      <span>${escapeHtml(SCOPE_LABELS[profile.scope])}</span>
      <div>
        <strong>${escapeHtml(profile.label)}</strong>
        <small>${escapeHtml(curveSummary(profile.curve))}</small>
      </div>
      <div class="saved-profile__actions">
        <button type="button" data-action="load" data-profile-scope="${profile.scope}" data-profile-key="${escapeHtml(profile.key)}">Editar</button>
        <button type="button" data-action="delete" data-profile-scope="${profile.scope}" data-profile-key="${escapeHtml(profile.key)}">Eliminar</button>
      </div>
    </article>
  `).join('');
}

function updateContextActions(): void {
  const key = profileKey(selectedScope, state.context[selectedScope]);
  const exists = Boolean(key && state.profiles.some((profile) => profile.scope === selectedScope && profile.key === key));
  deleteContextButton.disabled = !exists;
}

function renderAbState(): void {
  const original = recipe.bypass || engine.isOriginalSelected();
  element('ab-state').textContent = recipe.bypass ? 'Sin EQ' : original ? 'Original' : 'Con EQ';
  abButton.disabled = playButton.disabled || recipe.bypass;
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

function renderCurveLoop(): void {
  drawCurve();
  requestAnimationFrame(renderCurveLoop);
}

function drawCurve(): void {
  if (!context2d) return;
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
  const maximumGain = state.gainRange;
  const gainTicks = maximumGain === 12 ? [-12, -6, 0, 6, 12] : [-6, -3, 0, 3, 6];
  for (const gain of gainTicks) {
    const y = padding.top + ((maximumGain - gain) / (maximumGain * 2)) * plotHeight;
    ctx.strokeStyle = gain === 0 ? '#404651' : '#20242c';
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = '#737b89';
    ctx.fillText(`${gain > 0 ? '+' : ''}${gain}`, padding.left - 8 * ratio, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const frequency of [50, 120, 500, 1000, 3000, 6000, 16_000]) {
    const x = frequencyX(frequency, padding.left, plotWidth);
    ctx.strokeStyle = '#181c23';
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.stroke();
    ctx.fillStyle = '#737b89';
    ctx.fillText(formatFrequency(frequency), x, height - padding.bottom + 9 * ratio);
  }
  const response = engine.getResponseCurve();
  ctx.beginPath();
  for (let index = 0; index < response.frequencies.length; index += 1) {
    const x = frequencyX(response.frequencies[index] ?? 25, padding.left, plotWidth);
    const gain = Math.max(-maximumGain, Math.min(maximumGain, response.gainsDb[index] ?? 0));
    const y = padding.top + ((maximumGain - gain) / (maximumGain * 2)) * plotHeight;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = recipe.bypass || engine.isOriginalSelected() ? '#8d96a5' : '#f2b657';
  ctx.lineWidth = 2.5 * ratio;
  ctx.stroke();
}

function loadState(): LabState {
  const fallback: LabState = {
    mode: 'general',
    tuning: 'wide',
    gainRange: 6,
    general: copyCurve(NEUTRAL_CURVE),
    context: { track: '', album: '', artist: '', genre: '' },
    profiles: [],
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<LabState>;
    const mode: EqMode = parsed.mode === 'off' || parsed.mode === 'contextual' ? parsed.mode : 'general';
    const tuning: ToneTuningId = parsed.tuning === 'hifi' || parsed.tuning === 'audible' ? parsed.tuning : 'wide';
    const gainRange: 6 | 12 = parsed.gainRange === 12 ? 12 : 6;
    return {
      mode,
      tuning,
      gainRange,
      general: sanitizeCurve(parsed.general ?? fallback.general, gainRange),
      context: {
        track: String(parsed.context?.track ?? ''),
        album: String(parsed.context?.album ?? ''),
        artist: String(parsed.context?.artist ?? ''),
        genre: String(parsed.context?.genre ?? ''),
      },
      profiles: Array.isArray(parsed.profiles)
        ? parsed.profiles.filter(isStoredProfile).map((profile) => ({ ...profile, curve: sanitizeCurve(profile.curve, gainRange) }))
        : [],
    };
  } catch {
    return fallback;
  }
}

function persistState(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    setStatus('El ajuste funciona, pero este navegador no permitió guardarlo.', true);
  }
}

function isStoredProfile(value: unknown): value is StoredToneProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredToneProfile>;
  return (candidate.scope === 'track' || candidate.scope === 'album' || candidate.scope === 'artist' || candidate.scope === 'genre')
    && typeof candidate.key === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.updatedAt === 'string'
    && Boolean(candidate.curve)
    && typeof candidate.curve?.bass === 'number'
    && typeof candidate.curve?.mid === 'number'
    && typeof candidate.curve?.treble === 'number';
}

function setStatus(message: string, error = false): void {
  const status = element('status');
  status.textContent = message;
  status.classList.toggle('status--error', error);
}

function setContextStatus(message: string, error = false): void {
  const status = element('context-status');
  status.textContent = message;
  status.classList.toggle('context-status--error', error);
}

function curveSummary(curve: Readonly<ToneCurve>): string {
  return `Graves ${formatSigned(curve.bass)} · Medios ${formatSigned(curve.mid)} · Agudos ${formatSigned(curve.treble)} dB`;
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

function formatFrequencyLong(frequency: number): string {
  return frequency >= 1000
    ? `${Number((frequency / 1000).toFixed(frequency >= 10_000 ? 0 : 1))} kHz`
    : `${frequency} Hz`;
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function baseName(value: string): string {
  return value.replace(/\.[^.]+$/, '').trim() || value;
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
