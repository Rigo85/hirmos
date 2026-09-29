import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

const WORK = '.hirmos-cue-work';
const baseName = name => {
  if (!name || path.basename(name) !== name || name === '.' || name === '..') throw new Error('Nombre inseguro en el registro de publicación.');
  return name;
};
const hash = async (file, length) => {
  const h = createHash('sha256');
  if (length !== 0) for await (const chunk of createReadStream(file, length === undefined ? {} : { start: 0, end: length - 1 })) h.update(chunk);
  return h.digest('hex');
};
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (stat, id) => stat.isFile() && String(stat.dev) === id.dev && String(stat.ino) === id.ino;
const optionalStat = file => fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });

// Album-wide cooperative lock. Never reclaim automatically: a different host
// may still be writing the shared directory, and a PID can be reused.
export class Publication {
  constructor(directory, signal) {
    this.directory = directory;
    this.work = path.join(directory, WORK);
    this.signal = signal;
    this.events = [];
  }

  static async begin(directory, signal) {
    const tx = new Publication(directory, signal);
    try { await fs.mkdir(tx.work); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error('Existe una operación activa o interrumpida. Usa --recover cuando su proceso haya terminado.');
      throw e;
    }
    // If interrupted even before the owner is written, leave the lock for
    // manual inspection rather than risk deleting an unrelated directory.
    await fs.writeFile(path.join(tx.work, 'owner.json'), JSON.stringify({ host: hostname(), pid: process.pid }), { flag: 'wx' });
    await fs.writeFile(path.join(tx.work, '.ndignore'), '', { flag: 'wx' });
    tx.journal = await fs.open(path.join(tx.work, 'journal.jsonl'), 'ax');
    return tx;
  }

  async record(event) {
    await this.journal.writeFile(JSON.stringify(event) + '\n');
    await this.journal.sync();
    this.events.push(event);
  }

  async publish(source, name) {
    this.signal?.throwIfAborted();
    baseName(name);
    const payload = `payload-${this.events.length}`;
    const staged = path.join(this.work, payload);
    // Sequential reads/writes only: compatible with filesystems without seek.
    await this.copy(source, staged);
    const sha256 = await hash(staged);
    if (await hash(source) !== sha256) throw new Error('La copia de preparación no coincide con el archivo validado.');
    const destination = path.join(this.directory, name);
    await this.record({ type: 'intent', name, payload, sha256 });
    let handle;
    try {
      this.signal?.throwIfAborted();
      handle = await fs.open(destination, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') await this.record({ type: 'foreign', name });
      throw e;
    }
    try {
      await this.record({ type: 'created', name, identity: identity(await handle.stat()) });
      await this.write(staged, handle);
      await handle.sync();
    } finally { await handle.close(); }
    if (await hash(destination) !== sha256) throw new Error(`Publicación no verificada: ${name}`);
    await this.record({ type: 'done', name });
  }

  async write(source, handle) {
    for await (const chunk of createReadStream(source)) {
      this.signal?.throwIfAborted();
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (!bytesWritten) throw new Error('Escritura incompleta.');
        offset += bytesWritten;
      }
    }
  }

  async copy(source, destination) {
    const h = await fs.open(destination, 'wx');
    try { await this.write(source, h); await h.sync(); }
    finally { await h.close(); }
  }

  async finalize(source) {
    this.signal?.throwIfAborted();
    await this.witness(source);
    this.signal?.throwIfAborted();
    await this.record({ type: 'finalizing', source: baseName(source) });
  }

  async witness(name) {
    const file = path.join(this.directory, baseName(name));
    if (!(await fs.lstat(file)).isFile()) throw new Error('No se puede verificar un enlace como archivo propio.');
    await this.record({ type: 'witness', name, sha256: await hash(file) });
  }

  async trackStaging(directory) {
    const stat = await fs.lstat(directory);
    await this.record({ type: 'staging', directory, identity: identity(stat) });
  }

  async rollback() {
    if (this.events.some(e => e.type === 'finalizing')) {
      throw new Error('Audio publicado; falta finalizar .ndignore. Conservado para --recover.');
    }
    // Validate EVERY candidate before deleting any. A changed file or uncertain
    // ownership requires human inspection; never infer ownership from its name.
    const removable = [];
    for (const intent of this.events.filter(e => e.type === 'intent')) {
      if (this.events.some(e => e.type === 'foreign' && e.name === intent.name)) continue;
      const file = path.join(this.directory, baseName(intent.name));
      const stat = await optionalStat(file);
      if (!stat) continue;
      const created = this.events.find(e => e.type === 'created' && e.name === intent.name);
      const payload = path.join(this.work, baseName(intent.payload));
      if (!created || !same(stat, created.identity)) throw new Error(`Propiedad incierta: ${intent.name}; se conserva para revisión manual.`);
      const original = await fs.lstat(payload);
      const complete = this.events.some(e => e.type === 'done' && e.name === intent.name);
      if (!original.isFile() || await hash(payload) !== intent.sha256 || stat.size > original.size ||
          (complete && stat.size !== original.size) ||
          await hash(file) !== await hash(payload, stat.size)) {
        throw new Error(`Archivo modificado: ${intent.name}; no se elimina.`);
      }
      removable.push({ file, identity: created.identity, size: stat.size });
    }
    for (const entry of removable) {
      const stat = await fs.lstat(entry.file);
      if (!same(stat, entry.identity) || stat.size !== entry.size) throw new Error('Cambios concurrentes durante recuperación; operación detenida.');
      await fs.unlink(entry.file);
    }
    await this.finish();
  }

  async finish() {
    for (const event of this.events.filter(e => e.type === 'staging')) {
      const stat = await optionalStat(event.directory);
      if (!stat) continue;
      if (!stat.isDirectory() || !/^hirmos-cue-split-[a-zA-Z0-9]+$/.test(path.basename(event.directory)) ||
          await fs.realpath(path.dirname(event.directory)) !== await fs.realpath(tmpdir()) ||
          String(stat.dev) !== event.identity.dev || String(stat.ino) !== event.identity.ino) {
        throw new Error('El temporal local cambió; se conserva para revisión manual.');
      }
      await fs.rm(event.directory, { recursive: true });
    }
    await this.journal?.close();
    this.journal = undefined;
    // Remove only this known operation directory, never a caller-supplied path.
    await fs.rm(this.work, { recursive: true });
  }

  async close() { await this.journal?.close(); this.journal = undefined; }

  static async recover(directory, finalizeIgnore) {
    const tx = new Publication(directory);
    if (!(await fs.lstat(tx.work)).isDirectory()) throw new Error('Registro de recuperación inválido.');
    const owner = JSON.parse(await fs.readFile(path.join(tx.work, 'owner.json'), 'utf8'));
    if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) {
      throw new Error('Recupera desde el host original, después de comprobar que el proceso terminó.');
    }
    try { process.kill(owner.pid, 0); throw new Error('El proceso registrado sigue activo; no se recuperó.'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    // Prevent simultaneous recovery attempts. A killed recovery leaves this
    // marker deliberately, requiring inspection instead of a second writer.
    const recovery = await fs.open(path.join(tx.work, 'recovering'), 'wx');
    await recovery.close();
    try {
      const text = await fs.readFile(path.join(tx.work, 'journal.jsonl'), 'utf8');
      const lines = text.split('\n');
      lines.pop(); // only newline-committed records; truncated tail is untrusted
      tx.events = lines.filter(Boolean).map(line => JSON.parse(line));
      const finalizing = tx.events.find(e => e.type === 'finalizing');
      if (finalizing) {
        for (const intent of tx.events.filter(e => e.type === 'intent' || e.type === 'witness')) {
          const file = path.join(directory, baseName(intent.name));
          if (!(await fs.lstat(file)).isFile() || await hash(file) !== intent.sha256) throw new Error('No se puede finalizar: una salida cambió o está incompleta.');
        }
        await finalizeIgnore(baseName(finalizing.source));
        await tx.finish();
        return 'finalized';
      }
      await tx.rollback();
      return 'rolled-back';
    } catch (e) {
      await fs.unlink(path.join(tx.work, 'recovering')).catch(() => {});
      throw e;
    }
  }
}
