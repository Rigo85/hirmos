// Diagnostic fixture only. Observe the real native play() promise; never replace
// its result, force autoplay, change volume, or access application internals.
(() => {
  const rows = [];
  function record(event, extra = {}) {
    const row = { ms: Math.round(performance.now()), event,
      activation: navigator.userActivation?.isActive,
      everActive: navigator.userActivation?.hasBeenActive, ...extra };
    rows.push(row);
    if (rows.length > 80) rows.shift();
    const output = document.getElementById('audio-probe-output');
    if (output) output.textContent = rows.map(value => JSON.stringify(value)).join('\n');
  }
  record('document', { navigation: performance.getEntriesByType('navigation')[0]?.type,
    autoplayPolicy: document.permissionsPolicy?.allowsFeature('autoplay')
      ?? document.featurePolicy?.allowsFeature('autoplay'), visibility: document.visibilityState });
  const originalPlay = HTMLMediaElement.prototype.play;
  const watched = new WeakSet();
  HTMLMediaElement.prototype.play = function (...args) {
    const audio = this;
    if (!watched.has(audio)) {
      watched.add(audio);
      for (const event of ['loadedmetadata', 'playing', 'pause', 'error', 'seeking', 'seeked']) {
        audio.addEventListener(event, () => record(event, { position: audio.currentTime,
          ready: audio.readyState, mediaError: audio.error?.code ?? null }));
      }
    }
    record('play-call', { position: audio.currentTime, ready: audio.readyState,
      muted: audio.muted, sourceAssigned: Boolean(audio.getAttribute('src')) });
    const promise = originalPlay.apply(audio, args);
    promise?.then(() => record('play-resolved', { position: audio.currentTime }),
      error => record('play-rejected', { name: error.name, message: error.message }));
    return promise;
  };
  document.addEventListener('click', event => record('click', { trusted: event.isTrusted }), true);
  function mount() {
    const panel = document.createElement('details'); panel.open = true;
    const heading = document.createElement('summary'); heading.textContent = 'Diagnóstico local de audio';
    const output = document.createElement('pre'); output.id = 'audio-probe-output';
    panel.append(heading, output); document.body.prepend(panel); record('probe-ready');
    const audio = document.getElementById('control-audio');
    if (!audio) return;
    const query = new URLSearchParams(location.search);
    const resume = query.get('resume') === '1';
    const position = Math.max(0, Number(query.get('position')) || 0);
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = position; }, { once: true });
    const checkpoint = playing => history.replaceState(null, '', `?resume=${playing ? '1' : '0'}&position=${audio.currentTime}`);
    document.getElementById('control-play').onclick = () => { checkpoint(true); void audio.play().catch(() => {}); };
    document.getElementById('control-pause').onclick = () => { audio.pause(); checkpoint(false); };
    audio.addEventListener('timeupdate', () => { if (!audio.paused) checkpoint(true); });
    if (resume) {
      void audio.play().catch(() => {});
      // A second native call with ready data, without a new gesture, isolates
      // permission denial from premature loading / a short audio timeout.
      setTimeout(() => { record('delayed-control'); void audio.play().catch(() => {}); }, 2_000);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
