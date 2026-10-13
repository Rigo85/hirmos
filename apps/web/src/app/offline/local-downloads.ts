export interface LocalTrack {
  reference: string;
  title: string;
  artist: string;
  album: string;
  durationMs?: number;
  albumId?: string | null;
  artistId?: string | null;
  coverUrl?: string | null;
}
export interface LocalSource { body: ReadableStream<Uint8Array>; contentType: string; expectedBytes: number | null }
export interface LocalDownload {
  version: 1;
  owner: string;
  track: LocalTrack;
  fileId: string;
  state: 'writing' | 'ready' | 'interrupted' | 'missing' | 'corrupt' | 'deleting' | 'deleted';
  bytes: number;
  fingerprint: string | null;
  contentType: string;
  savedAt: string;
}
export interface LocalIndex {
  get(owner: string, reference: string): Promise<LocalDownload | undefined>;
  list(owner: string): Promise<LocalDownload[]>;
  put(record: LocalDownload): Promise<void>;
}
export interface LocalFiles {
  readExtra?(owner: string, fileId: string, name: 'cover' | 'lyrics'): Promise<Blob>;
  writeExtra?(owner: string, fileId: string, name: 'cover' | 'lyrics', data: Blob, signal?:AbortSignal, guard?:()=>void): Promise<void>;
  write(owner: string, fileId: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<number>;
  open(owner: string, fileId: string): Promise<Blob>;
  manifest(owner: string, fileId: string): Promise<unknown>;
  publish(record: LocalDownload): Promise<void>;
  ids(owner: string): Promise<string[]>;
  remove(owner: string, fileId: string): Promise<void>;
}
export interface LocalPorts {
  index: LocalIndex;
  files: LocalFiles;
  lock<T>(owner: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  fingerprint(file: Blob, signal?: AbortSignal): Promise<string>;
  space(requiredBytes: number | null): Promise<void>;
  uuid(): string;
}

export class LocalDownloadError extends Error {
  constructor(public readonly code: 'INVALID_RECORD' | 'INVALID_LENGTH' | 'UNSUPPORTED' | 'SPACE_REQUIRED') { super(code); }
}
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function checkOwner(owner: string): void {
  if (!uuidPattern.test(owner)) throw new LocalDownloadError('INVALID_RECORD');
}
export function checkFileId(fileId: string): void { checkOwner(fileId); }
export function validRecord(value: unknown, owner: string, fileId?: string): value is LocalDownload {
  if (!value || typeof value !== 'object') return false;
  const v = value as LocalDownload;
  return v.version === 1 && v.owner === owner && uuidPattern.test(v.fileId)
    && (!fileId || v.fileId === fileId)
    && !!v.track && typeof v.track.reference === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(v.track.reference)
    && [v.track.title, v.track.artist, v.track.album].every(s => typeof s === 'string' && s.length <= 1024)
    && (v.track.durationMs === undefined || (Number.isSafeInteger(v.track.durationMs) && v.track.durationMs >= 0))
    && [v.track.albumId,v.track.artistId].every(id=>id==null || (typeof id==='string' && /^[A-Za-z0-9_-]{1,2048}$/.test(id)))
    && (v.track.coverUrl==null || (typeof v.track.coverUrl==='string' && /^\/api\/music\/covers\/[A-Za-z0-9_-]+(?:\?size=\d+)?$/.test(v.track.coverUrl)))
    && ['writing','ready','interrupted','missing','corrupt','deleting','deleted'].includes(v.state)
    && Number.isSafeInteger(v.bytes) && v.bytes >= 0
    && (v.fingerprint === null || /^sha256-chunks-v1:[a-f0-9]{64}$/.test(v.fingerprint))
    && (v.state !== 'ready' || (v.bytes > 0 && v.fingerprint !== null))
    && typeof v.contentType === 'string' && /^(audio\/[a-z0-9.+-]+|application\/(octet-stream|ogg))$/i.test(v.contentType)
    && typeof v.savedAt === 'string' && Number.isFinite(Date.parse(v.savedAt));
}
const isMissing = (error: unknown) => (error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError';

/** Storage only: no cookies, session expiry, network, playback or automatic eviction. */
export class LocalDownloads {
  constructor(readonly owner: string, private readonly ports: LocalPorts) { checkOwner(owner); }

  async list(): Promise<LocalDownload[]> {
    const rows = await this.ports.index.list(this.owner);
    if (rows.some(r => !validRecord(r, this.owner))) throw new LocalDownloadError('INVALID_RECORD');
    return rows;
  }

  /** Sidecars share the original's directory and account lock. Never create an
   * audio directory from a late auxiliary response after removal/replacement. */
  async readExtra(reference: string, name: 'cover' | 'lyrics'): Promise<Blob | null> {
    return this.ports.lock(this.owner, async () => {
      const row = await this.ports.index.get(this.owner, reference);
      if (!row || !validRecord(row, this.owner) || row.state !== 'ready' || !this.ports.files.readExtra) return null;
      try { return await this.ports.files.readExtra(this.owner, row.fileId, name); }
      catch (error) { if (isMissing(error)) return null; throw error; }
    });
  }

  async saveExtra(reference: string, fileId: string, name: 'cover' | 'lyrics', data: Blob,
    signal: AbortSignal, guard: () => void, merge?: (existing: Blob | null, incoming: Blob) => Promise<Blob>): Promise<void> {
    await this.ports.lock(this.owner, async () => {
      signal.throwIfAborted(); guard();
      const row = await this.ports.index.get(this.owner, reference);
      if (!row || !validRecord(row, this.owner) || row.state !== 'ready' || row.fileId !== fileId) throw new Error('LOCAL_AUDIO_CHANGED');
      if (!this.ports.files.writeExtra) throw new Error('UNSUPPORTED');
      if (merge) {
        let previous: Blob | null = null;
        try { previous = await this.ports.files.readExtra?.(this.owner, fileId, name) ?? null; }
        catch (error) { if (!isMissing(error)) throw error; }
        data = await merge(previous, data);
        signal.throwIfAborted(); guard();
      }
      if (!data.size || data.size > (name === 'cover' ? 2 * 1024 ** 2 : 1024 ** 2)) throw new Error('INVALID_EXTRA');
      await this.ports.space(data.size);
      signal.throwIfAborted(); guard();
      await this.ports.files.writeExtra(this.owner, fileId, name, data, signal, guard);
    }, signal);
  }

  async save(track: LocalTrack, contentType: string, expectedBytes: number | null,
    source: () => Promise<ReadableStream<Uint8Array> | LocalSource>, signal?: AbortSignal, guard?:()=>Promise<void>): Promise<LocalDownload> {
    return this.ports.lock(this.owner, async () => {
      signal?.throwIfAborted();
      await guard?.();
      if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)) {
        throw new LocalDownloadError('INVALID_LENGTH');
      }
      const record: LocalDownload = { version:1, owner:this.owner, track:{...track},
        fileId:this.ports.uuid(), state:'writing', bytes:0, fingerprint:null,
        contentType, savedAt:new Date().toISOString() };
      if (!validRecord(record, this.owner)) throw new LocalDownloadError('INVALID_RECORD');
      const existing = await this.ports.index.get(this.owner, track.reference);
      if (existing) {
        if (!validRecord(existing, this.owner)) throw new LocalDownloadError('INVALID_RECORD');
        if (existing.state === 'writing' || existing.state === 'interrupted') {
          let manifest: unknown;
          try { manifest = await this.ports.files.manifest(this.owner, existing.fileId); }
          catch (error) { if (!isMissing(error) && !(error instanceof SyntaxError)) throw error; }
          if (validRecord(manifest, this.owner, existing.fileId) && manifest.state === 'ready'
            && manifest.track.reference === track.reference) {
            const recovered = await this.inspect(manifest, true, signal);
            if (recovered.state === 'ready') return recovered;
          }
        }
        // An explicit attempt to download again verifies and reuses a good copy, even after a new login.
        const checked = await this.inspect(existing, true, signal);
        if (checked.state === 'ready') {
          const enriched={...checked,track:{...checked.track,...track}};
          await this.ports.files.publish(enriched);await this.ports.index.put(enriched);
          return enriched;
        }
      }
      await this.ports.space(expectedBytes);
      // Do not orphan the previous indexed attempt when replacing its fileId.
      // Keep the deletion intent durable until cleanup completes; an interrupted
      // cleanup is retried by reconciliation before any new file is published.
      if (existing) {
        const intent: LocalDownload = {...existing, state:'deleting'};
        await this.ports.index.put(intent);
        await this.finishDeletion(intent);
      }
      signal?.throwIfAborted();
      await this.ports.index.put(record);
      let published = false;
      try {
        const obtained = await source();
        const body = 'body' in obtained ? obtained.body : obtained;
        if ('body' in obtained) {
          expectedBytes = obtained.expectedBytes; record.contentType = obtained.contentType;
          if (!validRecord(record, this.owner) || (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0))) {
            await body.cancel().catch(() => undefined); throw new LocalDownloadError('INVALID_RECORD');
          }
          try { await this.ports.space(expectedBytes); }
          catch (error) { await body.cancel().catch(() => undefined); throw error; }
        }
        record.bytes = await this.ports.files.write(this.owner, record.fileId, body, signal);
        if (!record.bytes || (expectedBytes !== null && record.bytes !== expectedBytes)) throw new LocalDownloadError('INVALID_LENGTH');
        const file = await this.ports.files.open(this.owner, record.fileId);
        if (file.size !== record.bytes) throw new LocalDownloadError('INVALID_LENGTH');
        record.fingerprint = await this.ports.fingerprint(file, signal);
        signal?.throwIfAborted();
        record.state = 'ready';
        // No cross-storage transaction exists. Publish recovery manifest before committing readiness in IDB.
        await this.ports.files.publish(record); published = true;
        await this.ports.index.put(record);
        return record;
      } catch (error) {
        if (!published) {
          record.state = 'interrupted';
          await this.ports.index.put(record).catch(() => undefined);
        }
        // A committed manifest can be recovered after an IDB failure; never delete it on error.
        throw error;
      }
    }, signal);
  }

  async check(reference: string, audit = false, signal?: AbortSignal): Promise<LocalDownload | undefined> {
    return this.ports.lock(this.owner, async () => {
      const row = await this.ports.index.get(this.owner, reference);
      return row ? this.inspect(row, audit, signal) : undefined;
    }, signal);
  }

  /** Open under the same lock as writers/removals; never turn an index entry into a remote fallback. */
  async openAudio(reference: string, signal?: AbortSignal): Promise<{record:LocalDownload;file:Blob}> {
    return this.ports.lock(this.owner, async () => {
      const row = await this.ports.index.get(this.owner, reference);
      if (!row) throw new Error('LOCAL_AUDIO_MISSING');
      const checked = await this.inspect(row, false, signal);
      if (checked.state !== 'ready') throw new Error(`LOCAL_AUDIO_${checked.state.toUpperCase()}`);
      try {
        const file = await this.ports.files.open(this.owner, checked.fileId);
        if (file.size !== checked.bytes) {
          await this.ports.index.put({...checked,state:'corrupt'});
          throw new Error('LOCAL_AUDIO_CORRUPT');
        }
        return {record:checked,file:file.slice(0,file.size,checked.contentType)};
      } catch (error) {
        if (isMissing(error)) {
          await this.ports.index.put({...checked,state:'missing'});
          throw new Error('LOCAL_AUDIO_MISSING');
        }
        throw error;
      }
    },signal);
  }

  /** Durable tombstone prevents recovery manifests from resurrecting an explicit deletion. */
  async remove(reference: string): Promise<void> {
    return this.mutate(remove=>remove(reference));
  }

  async updateMetadata(tracks:LocalTrack[],signal?:AbortSignal):Promise<void> {
    await this.ports.lock(this.owner,async()=>{
      for(const track of tracks){
        signal?.throwIfAborted();const row=await this.ports.index.get(this.owner,track.reference);
        signal?.throwIfAborted();
        if(!row||row.state!=='ready')continue;
        const updated={...row,track:{...row.track,...track}};
        if(!validRecord(updated,this.owner))throw new LocalDownloadError('INVALID_RECORD');
        await this.ports.files.publish(updated);await this.ports.index.put(updated);
      }
    },signal);
  }

  /** Plans and file deletion share the account lock with writers. No nested locks. */
  async mutate<T>(operation:(remove:(reference:string)=>Promise<void>)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    return this.ports.lock(this.owner,()=>operation(async reference=>{
      const row = await this.ports.index.get(this.owner, reference);
      if (!row) return;
      if (!validRecord(row, this.owner)) throw new LocalDownloadError('INVALID_RECORD');
      const intent: LocalDownload = {...row, state:'deleting'};
      await this.ports.index.put(intent);
      await this.finishDeletion(intent);
    }),signal);
  }

  private async finishDeletion(row: LocalDownload): Promise<LocalDownload> {
    // Remove the exact indexed object plus older verified versions of this same track only.
    const targets = new Set([row.fileId]);
    for (const fileId of await this.ports.files.ids(this.owner)) {
      let manifest: unknown;
      try { manifest = await this.ports.files.manifest(this.owner,fileId); }
      catch (error) { if (isMissing(error) || error instanceof SyntaxError) continue; throw error; }
      if (validRecord(manifest,this.owner,fileId) && manifest.track.reference === row.track.reference) targets.add(fileId);
    }
    for (const fileId of targets) await this.ports.files.remove(this.owner,fileId);
    const deleted: LocalDownload = {...row,state:'deleted',bytes:0,fingerprint:null};
    await this.ports.index.put(deleted); return deleted;
  }

  async reconcile(audit = false, signal?: AbortSignal): Promise<{ records: LocalDownload[]; unclaimed: number }> {
    return this.ports.lock(this.owner, async () => {
      const indexed = new Map((await this.list()).map(row => [row.track.reference, row]));
      const candidates = new Map<string, LocalDownload[]>();
      let unclaimed = 0;
      // Read one small manifest at a time. Unknown/ambiguous files remain untouched.
      for (const fileId of await this.ports.files.ids(this.owner)) {
        signal?.throwIfAborted();
        let record: unknown;
        try { record = await this.ports.files.manifest(this.owner, fileId); }
        catch (error) { if (isMissing(error) || error instanceof SyntaxError) { unclaimed++; continue; } throw error; }
        if (!validRecord(record, this.owner, fileId) || record.state !== 'ready') { unclaimed++; continue; }
        const current = indexed.get(record.track.reference);
        if (current && current.fileId !== fileId) { unclaimed++; continue; }
        const group = candidates.get(record.track.reference) ?? [];
        group.push(record); candidates.set(record.track.reference, group);
      }
      for (const [reference, group] of candidates) {
        if (group.length !== 1) { unclaimed += group.length; continue; }
        const current = indexed.get(reference);
        // A ready manifest bridges a crash between OPFS publication and IDB commit, or loss of IDB.
        if (!current || current.state === 'writing' || current.state === 'interrupted') {
          const recovered = await this.inspect(group[0], true, signal);
          indexed.set(reference, recovered);
        }
      }
      for (const [reference, row] of indexed) indexed.set(reference, await this.inspect(row, audit, signal));
      return { records:[...indexed.values()], unclaimed };
    }, signal);
  }

  private async inspect(row: LocalDownload, audit: boolean, signal?: AbortSignal): Promise<LocalDownload> {
    signal?.throwIfAborted();
    if (!validRecord(row, this.owner)) throw new LocalDownloadError('INVALID_RECORD');
    if (row.state === 'deleting') return this.finishDeletion(row);
    if (row.state === 'deleted') return row;
    const checked = { ...row };
    if (row.state === 'writing') checked.state = 'interrupted';
    if (row.state !== 'writing' && row.state !== 'interrupted') {
      try {
        const file = await this.ports.files.open(this.owner, row.fileId);
        checked.state = file.size !== row.bytes ? 'corrupt'
          : audit && await this.ports.fingerprint(file, signal) !== row.fingerprint ? 'corrupt'
          : audit || row.state === 'ready' ? 'ready' : row.state;
      } catch (error) {
        if (!isMissing(error)) throw error; // Permissions/I/O failure is not evidence of deletion.
        checked.state = 'missing';
      }
    }
    await this.ports.index.put(checked);
    return checked;
  }
}
