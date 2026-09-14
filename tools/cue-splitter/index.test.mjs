import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTrackPlan,
  buildSourceIgnoreUpdate,
  classifyExistingTracks,
  cueTimestampToFrames,
  parseCue,
} from './index.mjs';

const SAMPLE = `REM DATE 2013
PERFORMER "Adrenaline Mob"
TITLE "Coverta"
FILE "Adrenaline Mob - Coverta.flac" WAVE
  TRACK 01 AUDIO
    TITLE "High Wire"
    PERFORMER "Adrenaline Mob"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Stand Up And Shout"
    INDEX 00 03:48:60
    INDEX 01 03:48:67
`;

test('interpreta metadatos e índices de un CUE de imagen única', () => {
  const cue = parseCue(SAMPLE);

  assert.equal(cue.album.title, 'Coverta');
  assert.equal(cue.album.performer, 'Adrenaline Mob');
  assert.equal(cue.album.date, '2013');
  assert.equal(cue.sourceFile, 'Adrenaline Mob - Coverta.flac');
  assert.equal(cue.tracks[1].title, 'Stand Up And Shout');
  assert.equal(cue.tracks[1].index00Frames, cueTimestampToFrames('03:48:60'));
  assert.equal(cue.tracks[1].index01Frames, cueTimestampToFrames('03:48:67'));
});

test('calcula cortes exactos en muestras y asigna el pregap a la pista anterior', () => {
  const cue = parseCue(SAMPLE);
  const plan = buildTrackPlan(cue, {
    sampleRate: 44_100,
    totalSamples: 20_000_000,
  });

  assert.equal(plan[0].startSample, 0);
  assert.equal(plan[0].endSample, cueTimestampToFrames('03:48:67') * 588);
  assert.equal(plan[0].outputFile, '01 - High Wire.flac');
  assert.equal(plan[1].outputFile, '02 - Stand Up And Shout.flac');
});

test('reconoce pistas existentes mediante tags aunque el archivo tenga otro nombre', () => {
  const cue = parseCue(SAMPLE);
  const plan = buildTrackPlan(cue, {
    sampleRate: 44_100,
    totalSamples: 20_000_000,
  });
  const result = classifyExistingTracks(plan, [
    {
      file: 'high-wire.flac',
      durationSeconds: plan[0].durationSeconds,
      tags: {
        TRACKNUMBER: '1/2',
        TITLE: 'High Wire',
        ARTIST: 'Adrenaline Mob',
        ALBUM: 'Coverta',
        ALBUMARTIST: 'Adrenaline Mob',
      },
    },
  ]);

  assert.equal(result.status, 'partial');
  assert.equal(result.matches.get(1).file, 'high-wire.flac');
  assert.deepEqual(result.missing.map((track) => track.number), [2]);
});

test('no acepta como existente una pista con título correcto y duración incorrecta', () => {
  const cue = parseCue(SAMPLE);
  const plan = buildTrackPlan(cue, {
    sampleRate: 44_100,
    totalSamples: 20_000_000,
  });
  const result = classifyExistingTracks(plan, [
    {
      file: '01 - High Wire.flac',
      durationSeconds: 10,
      tags: {
        TRACKNUMBER: '1',
        TITLE: 'High Wire',
        ARTIST: 'Adrenaline Mob',
        ALBUM: 'Coverta',
        ALBUMARTIST: 'Adrenaline Mob',
      },
    },
  ]);

  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].reason, 'la duración no coincide');
});

test('rechaza un archivo con nombre correcto pero metadata incompleta', () => {
  const cue = parseCue(SAMPLE);
  const plan = buildTrackPlan(cue, {
    sampleRate: 44_100,
    totalSamples: 20_000_000,
  });
  const result = classifyExistingTracks(plan, [
    {
      file: '01 - High Wire.flac',
      durationSeconds: plan[0].durationSeconds,
      tags: { TITLE: 'High Wire' },
    },
  ]);

  assert.equal(result.status, 'conflict');
  assert.match(result.conflicts[0].reason, /TRACK no coincide/);
  assert.match(result.conflicts[0].reason, /ALBUMARTIST no coincide/);
});

test('crea una regla exacta para ocultar solamente la imagen original', () => {
  const update = buildSourceIgnoreUpdate(undefined, 'Album [Disc 1]?.flac');

  assert.equal(update.status, 'missing');
  assert.equal(update.changed, true);
  assert.match(update.addition, /^# Hirmos CUE splitter:/);
  assert.equal(update.rule, '/Album \\[Disc 1\\]\\?.flac');
  assert.ok(update.addition.endsWith(`${update.rule}\n`));
});

test('agrega la regla sin reemplazar un .ndignore existente y es idempotente', () => {
  const first = buildSourceIgnoreUpdate('/otro.flac\n', 'imagen.flac');
  assert.equal(first.addition, '# Hirmos CUE splitter: preserve source without indexing it\n/imagen.flac\n');

  const second = buildSourceIgnoreUpdate(
    `/otro.flac\n${first.addition}`,
    'imagen.flac',
  );
  assert.equal(second.status, 'present');
  assert.equal(second.changed, false);
});

test('no cambia un .ndignore vacío porque excluye el álbum completo', () => {
  const update = buildSourceIgnoreUpdate('', 'imagen.flac');

  assert.equal(update.status, 'directory-ignored');
  assert.equal(update.changed, false);
});
