import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { parseCue, buildTrackPlan } from './index.mjs';
import { Publication } from './publication.mjs';

const cli = new URL('./index.mjs', import.meta.url).pathname;
const publicationUrl = new URL('./publication.mjs', import.meta.url).href;
const cue = `PERFORMER "Example Artist"
TITLE "Example Album"
REM DISCNUMBER 2
REM TOTALDISCS 3
FILE "source.flac" WAVE
TRACK 01 AUDIO
TITLE "First"
ISRC USABC2400001
INDEX 00 00:00:00
INDEX 01 00:00:15
TRACK 02 AUDIO
TITLE "Second"
INDEX 01 00:01:00
`;
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(process.env.HIRMOS_CUE_TEST_DIR ?? tmpdir(), 'hirmos-cue-regression-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
const probe = file => JSON.parse(run('ffprobe', ['-v','error','-show_format','-show_streams','-of','json',file]));
const pcm = file => execFileSync('ffmpeg', ['-v','error','-i',file,'-map','0:a:0','-f','s32le','-c:a','pcm_s32le','pipe:1'], { maxBuffer: 4_000_000, timeout: 30_000 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, embedded=false) {
  const dir = await temp(t);
  // Generate fixtures on a seek-capable local filesystem even when testing
  // publication on GVFS. Upload the finished files using sequential copy.
  const local = await fs.mkdtemp(path.join(tmpdir(), 'hirmos-cue-fixture-'));
  t.after(() => fs.rm(local, { recursive: true, force: true }));
  // PPM is an unambiguous synthetic test image, not user artwork.
  const ppm = path.join(local, 'test.ppm');
  await fs.writeFile(ppm, Buffer.concat([Buffer.from('P6\n8 8\n255\n'), Buffer.alloc(8*8*3, 120)]));
  run('ffmpeg', ['-v','error','-i',ppm,'-frames:v','1','-threads','1',path.join(local,'Unusual artwork name.png')]);
  run('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2:sample_rate=44100',
    ...(embedded ? ['-i',path.join(local,'Unusual artwork name.png')] : []),
    '-map','0:a:0', ...(embedded ? ['-map','1:v:0','-c:v','copy','-disposition:v:0','attached_pic'] : []),
    '-c:a','flac',path.join(local,'source.flac')]);
  await fs.writeFile(path.join(dir,'source.flac'), await fs.readFile(path.join(local,'source.flac')));
  if (!embedded) await fs.writeFile(path.join(dir,'Unusual artwork name.png'), await fs.readFile(path.join(local,'Unusual artwork name.png')));
  await fs.writeFile(path.join(dir,'album.cue'),cue);
  return dir;
}

test('rechaza TRACK duplicados, descendentes, inválidos y CUE mixto', () => {
  for (const invalid of [cue.replace('TRACK 02','TRACK 01'), cue.replace('TRACK 01','TRACK 00'),
    cue.replace('TRACK 02','TRACK 100'), cue.replace('TRACK 02 AUDIO','TRACK 02 MODE1/2352'),
    cue.replace('TRACK 01','TRACK 03')]) assert.throws(() => parseCue(invalid), /TRACK|AUDIO/);
  assert.throws(() => parseCue(cue.replace('INDEX 01 00:01:00','INDEX 01 00:01:00\nINDEX 01 00:01:01')), /INDEX repetido/);
});

test('preserva audio anterior a INDEX 01 y rechaza inicio fuera de fuente', () => {
  const parsed = parseCue(cue);
  const plan = buildTrackPlan(parsed, { sampleRate:44100,totalSamples:88200 });
  assert.equal(plan[0].startSample,0);
  assert.equal(plan[0].endSample,44100);
  assert.equal(parsed.tracks[0].isrc,'USABC2400001');
  assert.equal(parsed.album.discNumber,2);
  assert.throws(() => buildTrackPlan(parsed,{sampleRate:44100,totalSamples:22050}), /INDEX|Límites/);
});

for (const embedded of [false,true]) test(`FLAC completo: PCM íntegro, ISRC/disco y portada ${embedded?'incrustada':'de nombre libre'}`, async t => {
  const dir = await fixture(t,embedded);
  const before = digest(await fs.readFile(path.join(dir,'source.flac')));
  run(process.execPath,[cli,'--apply',dir]);
  const first = path.join(dir,'01 - First.flac'), second=path.join(dir,'02 - Second.flac');
  assert.equal(digest(Buffer.concat([pcm(first),pcm(second)])),digest(pcm(path.join(dir,'source.flac'))));
  assert.equal(digest(await fs.readFile(path.join(dir,'source.flac'))),before);
  const result = probe(first);
  assert.equal(result.format.tags.ISRC ?? result.format.tags.isrc,'USABC2400001');
  assert.equal(result.format.tags.disc,'2/3');
  assert.equal(result.format.tags.disctotal,'3');
  assert.ok(result.streams.some(s=>s.disposition.attached_pic===1));
  const stat = await fs.stat(first);
  assert.match(run(process.execPath,[cli,'--apply',dir]),/no se regeneró audio/);
  assert.equal((await fs.stat(first)).mtimeMs,stat.mtimeMs);
  assert.match(await fs.readFile(path.join(dir,'.ndignore'),'utf8'),/\nsource.flac\n/);
  assert.ok(!(await fs.readdir(dir)).includes('.hirmos-cue-work'));
  // The real --apply path repairs legacy rules by appending, not replacing
  // user contents; repeating it must not duplicate the effective rule.
  const old='# unrelated user comment\n/other.flac\n# Hirmos CUE splitter: preserve source without indexing it\n/source.flac\n';
  await fs.writeFile(path.join(dir,'.ndignore'),old);
  run(process.execPath,[cli,'--apply',dir]);
  const repaired=await fs.readFile(path.join(dir,'.ndignore'),'utf8');
  assert.ok(repaired.startsWith(old));
  assert.match(repaired,/\nsource.flac\n/);
  run(process.execPath,[cli,'--apply',dir]);
  assert.equal(await fs.readFile(path.join(dir,'.ndignore'),'utf8'),repaired);
});

test('publicación exclusiva conserva archivo ajeno y bloqueo impide segundo escritor', async t => {
  const dir=await temp(t), source=path.join(dir,'source');
  await fs.writeFile(source,'audio');
  const tx=await Publication.begin(dir);
  await assert.rejects(Publication.begin(dir), /activa o interrumpida/);
  await fs.writeFile(path.join(dir,'output'),'foreign');
  await assert.rejects(tx.publish(source,'output'),{code:'EEXIST'});
  await tx.rollback();
  assert.equal(await fs.readFile(path.join(dir,'output'),'utf8'),'foreign');
});

test('error de escritura revierte solo el prefijo propio', async t => {
  const dir=await temp(t), source=path.join(dir,'source');
  await fs.writeFile(source,'original bytes');
  const tx=await Publication.begin(dir);
  const normalWrite=tx.write.bind(tx);
  tx.write=async (file,handle)=> {
    if (file.startsWith(tx.work)) { await handle.write(Buffer.from('orig')); throw new Error('simulated I/O failure'); }
    await normalWrite(file,handle);
  };
  await assert.rejects(tx.publish(source,'output'),/simulated/);
  await tx.rollback();
  assert.deepEqual((await fs.readdir(dir)).sort(),['source']);
});

test('rollback conserva una salida modificada externamente', async t => {
  const dir=await temp(t), source=path.join(dir,'source');
  await fs.writeFile(source,'audio');
  const tx=await Publication.begin(dir);
  await tx.publish(source,'output');
  await fs.writeFile(path.join(dir,'output'),'changed');
  await assert.rejects(tx.rollback(),/modificado/);
  await tx.close();
  assert.equal(await fs.readFile(path.join(dir,'output'),'utf8'),'changed');
});

async function crash(t, dir, finalize=false, partial=false) {
  const code=`import {Publication} from ${JSON.stringify(publicationUrl)};
    setInterval(()=>{},1000);
    const tx=await Publication.begin(${JSON.stringify(dir)});
    ${partial ? "const write=tx.write.bind(tx); tx.write=async(file,h)=>{if(file.startsWith(tx.work)){await h.write(Buffer.from('orig')); console.log('READY'); await new Promise(()=>{});}else await write(file,h);};" : ''}
    await tx.publish(${JSON.stringify(path.join(dir,'source'))},'output');
    ${finalize ? "await tx.finalize('source');" : ''}
    console.log('READY');`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  const exit=once(child,'exit');
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('child readiness timeout')),5000);
    child.stdout.on('data',chunk=>{if(chunk.toString().includes('READY')){clearTimeout(timer);resolve();}});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    let errors=''; child.stderr.on('data',c=>{errors+=c;});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(`Child exited before ready: ${errors}`));});
  });
  child.kill('SIGKILL'); const [,signal]=await exit; assert.equal(signal,'SIGKILL');
}

for (const partial of [false,true]) test(`SIGKILL: --recover revierte salida ${partial?'parcial':'completa'} sin tocar fuente`, async t => {
  const dir=await temp(t);
  await fs.writeFile(path.join(dir,'source'),'original');
  await crash(t,dir,false,partial);
  assert.match(run(process.execPath,[cli,'--recover',dir]),/rolled-back/);
  assert.deepEqual(await fs.readdir(dir),['source']);
});

test('SIGKILL al finalizar: --recover conserva audio y completa exclusión', async t => {
  const dir=await temp(t);
  await fs.writeFile(path.join(dir,'source'),'original');
  await crash(t,dir,true);
  assert.match(run(process.execPath,[cli,'--recover',dir]),/finalized/);
  assert.equal(await fs.readFile(path.join(dir,'output'),'utf8'),'original');
  assert.match(await fs.readFile(path.join(dir,'.ndignore'),'utf8'),/\nsource\n/);
});

test('recuperación rechaza propietario vivo', async t => {
  const dir=await temp(t),tx=await Publication.begin(dir);
  await assert.rejects(Publication.recover(dir,()=>{}),/sigue activo/);
  await tx.rollback();
});

test('recuperación no finaliza ni excluye una fuente modificada', async t => {
  const dir=await temp(t);
  await fs.writeFile(path.join(dir,'source'),'original');
  await crash(t,dir,true);
  await fs.writeFile(path.join(dir,'source'),'changed');
  await assert.rejects(Publication.recover(dir,()=>{throw new Error('must not call');}),/cambió o está incompleta/);
  assert.equal(await fs.readFile(path.join(dir,'output'),'utf8'),'original');
  assert.ok(!(await fs.readdir(dir)).includes('.ndignore'));
});

test('recuperación rechaza origen de propietario en otro host', async t => {
  const dir=await temp(t),tx=await Publication.begin(dir);
  await tx.close();
  await fs.writeFile(path.join(tx.work,'owner.json'),JSON.stringify({host:'another-host.example',pid:123}));
  await assert.rejects(Publication.recover(dir,()=>{}),/host original/);
});

test('fallo antes de publicar conserva fuente y limpia staging registrado', async t => {
  const dir=await temp(t),tx=await Publication.begin(dir);
  const stage=await fs.mkdtemp(path.join(tmpdir(),'hirmos-cue-split-'));
  t.after(()=>fs.rm(stage,{recursive:true,force:true}));
  await tx.trackStaging(stage);
  await fs.writeFile(path.join(stage,'sample'),'temporary');
  await tx.rollback();
  await assert.rejects(fs.access(stage),{code:'ENOENT'});
});

for (const stop of ['SIGINT','SIGTERM']) test(`${stop} del CLI no deja pistas parciales ni bloqueo`, async t => {
  const dir=await fixture(t);
  const child=spawn(process.execPath,[cli,'--apply',dir],{stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  let stopped=false;
  child.stdout.on('data',chunk=>{if(!stopped && chunk.toString().includes('Generando ')){stopped=true;child.kill(stop);}});
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  t.after(()=>{clearTimeout(timer);child.kill('SIGKILL');});
  const [code]=await exited;
  assert.ok(stopped); assert.notEqual(code,0);
  const files=await fs.readdir(dir);
  assert.ok(files.includes('source.flac'));
  assert.ok(!files.includes('.hirmos-cue-work'));
  assert.ok(!files.some(f=>/^\d\d - /.test(f)));
});
