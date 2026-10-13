import { checkFileId, checkOwner, LocalDownloadError, type LocalDownload, type LocalPorts, validRecord } from './local-downloads';

const CHUNK_BYTES = 1024 * 1024;
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
async function digest(bytes: ArrayBuffer): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', bytes)); }

// Bounded memory, explicit algorithm version. This is NOT the whole-file SHA-256 from the provider.
export async function fingerprintFile(file: Blob, signal?: AbortSignal): Promise<string> {
  const chunks: string[] = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    signal?.throwIfAborted();
    chunks.push(await digest(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
  }
  signal?.throwIfAborted();
  const descriptor = new TextEncoder().encode(JSON.stringify(['sha256-chunks-v1', CHUNK_BYTES, file.size, chunks]));
  return `sha256-chunks-v1:${await digest(descriptor.buffer)}`;
}

/** IDB promises settle on transaction commit, never merely on request success. */
export async function downloadIndex<T>(name: string, mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>, storeName = 'downloads'): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(name, 3);
    let blocked = false;
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('downloads')) open.result.createObjectStore('downloads', {keyPath:['owner','track.reference']});
      if (!open.result.objectStoreNames.contains('plans')) open.result.createObjectStore('plans', {keyPath:['owner','id']});
      if (!open.result.objectStoreNames.contains('playback')) open.result.createObjectStore('playback', {keyPath:'owner'});
    };
    open.onsuccess = () => { if (blocked) open.result.close(); else resolve(open.result); };
    open.onerror = () => reject(open.error);
    open.onblocked = () => { blocked = true; reject(new Error('LOCAL_INDEX_BLOCKED')); };
  });
  db.onversionchange = () => db.close();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let request: IDBRequest<T>;
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? new Error('LOCAL_INDEX_ABORTED'));
      tx.onerror = () => { /* onabort is authoritative */ };
      try { request = operation(tx.objectStore(storeName)); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export function browserDownloadStorage(namespace = 'hirmos-downloads-v1'): LocalPorts {
  // Isolated synthetic fixtures cannot accidentally open the real download inventory.
  if (namespace !== 'hirmos-downloads-v1' && !/^hirmos-downloads-lab-[a-z0-9-]{1,64}$/.test(namespace)) {
    throw new LocalDownloadError('INVALID_RECORD');
  }
  if (!globalThis.isSecureContext || !navigator.storage?.getDirectory || !navigator.locks || !globalThis.indexedDB || !crypto.subtle) {
    throw new LocalDownloadError('UNSUPPORTED');
  }
  const ownerKey = async (owner: string) => { checkOwner(owner); return digest(new TextEncoder().encode(owner).buffer); };
  async function ownerDirectory(owner: string, create = false): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(namespace, {create});
    return directory.getDirectoryHandle(await ownerKey(owner), {create});
  }
  async function objectDirectory(owner: string, fileId: string, create = false): Promise<FileSystemDirectoryHandle> {
    checkFileId(fileId);
    return (await ownerDirectory(owner, create)).getDirectoryHandle(fileId, {create});
  }
  return {
    index: {
      get: (owner, reference) => { checkOwner(owner); return downloadIndex(namespace, 'readonly', s => s.get([owner, reference])); },
      list: (owner) => { checkOwner(owner); return downloadIndex(namespace, 'readonly', s => s.getAll(IDBKeyRange.bound([owner, ''], [owner, '\uffff']))); },
      put: async record => {
        checkOwner(record.owner);
        if (!validRecord(record, record.owner)) throw new LocalDownloadError('INVALID_RECORD');
        await downloadIndex(namespace, 'readwrite', s => s.put(record));
      },
    },
    files: {
      async readExtra(owner, fileId, name) {
        const file = await (await (await objectDirectory(owner, fileId)).getFileHandle(name === 'cover' ? 'cover' : 'lyrics.json')).getFile();
        if (file.size > (name === 'cover' ? 2 * 1024 ** 2 : 1024 ** 2)) throw new Error('INVALID_EXTRA');
        return file;
      },
      async writeExtra(owner, fileId, name, data, signal, guard) {
        // createWritable publishes on close; an interrupted update preserves the previous file.
        const dir = await objectDirectory(owner, fileId);
        const writer = await (await dir.getFileHandle(name === 'cover' ? 'cover' : 'lyrics.json', {create:true})).createWritable();
        try { signal?.throwIfAborted();guard?.();await writer.write(data);signal?.throwIfAborted();guard?.();await writer.close(); }
        catch (error) { await writer.abort().catch(() => undefined); throw error; }
      },
      async remove(owner, fileId) {
        checkFileId(fileId);
        try { await (await ownerDirectory(owner)).removeEntry(fileId, {recursive:true}); }
        catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
      },
      async write(owner, fileId, body, signal) {
        const reader = body.getReader();
        let writer: FileSystemWritableFileStream | undefined;
        let bytes = 0;
        const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
        signal?.addEventListener('abort', cancel, {once:true});
        try {
          signal?.throwIfAborted();
          const dir = await objectDirectory(owner, fileId, true);
          writer = await (await dir.getFileHandle('audio', {create:true})).createWritable();
          while (true) {
            signal?.throwIfAborted();
            const {done, value} = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            await writer.write(value as Uint8Array<ArrayBuffer>);
            bytes += value.byteLength;
          }
          await writer.close(); writer = undefined;
          return bytes;
        } catch (error) {
          await writer?.abort().catch(() => undefined);
          throw error;
        } finally {
          signal?.removeEventListener('abort', cancel);
          await reader.cancel().catch(() => undefined); reader.releaseLock();
        }
      },
      async open(owner, fileId) {
        const dir = await objectDirectory(owner, fileId);
        return (await dir.getFileHandle('audio')).getFile();
      },
      async manifest(owner, fileId) {
        const dir = await objectDirectory(owner, fileId);
        const file = await (await dir.getFileHandle('manifest.json')).getFile();
        if (file.size > 32768) return null;
        return JSON.parse(await file.text());
      },
      async publish(record) {
        if (!validRecord(record, record.owner) || record.state !== 'ready') throw new LocalDownloadError('INVALID_RECORD');
        const dir = await objectDirectory(record.owner, record.fileId);
        const writer = await (await dir.getFileHandle('manifest.json', {create:true})).createWritable();
        try { await writer.write(JSON.stringify(record)); await writer.close(); }
        catch (error) { await writer.abort().catch(() => undefined); throw error; }
      },
      async ids(owner) {
        let dir: FileSystemDirectoryHandle;
        try { dir = await ownerDirectory(owner); }
        catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return []; throw error; }
        const result: string[] = [];
        for await (const [name, handle] of (dir as FileSystemDirectoryHandle & {
          entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
        }).entries()) {
          if (handle.kind === 'directory') {
            try { checkFileId(name); result.push(name); } catch { /* never adopt arbitrary paths */ }
          }
        }
        return result;
      },
    },
    async lock(owner, operation, signal) {
      return navigator.locks.request(`${namespace}:${await ownerKey(owner)}`, {mode:'exclusive', signal}, operation);
    },
    async space(requiredBytes) {
      const {usage, quota} = await navigator.storage.estimate();
      if (quota !== undefined && usage !== undefined && quota - usage < (requiredBytes ?? 0) + 16 * CHUNK_BYTES) {
        throw new LocalDownloadError('SPACE_REQUIRED');
      }
      // Estimate is advisory; QuotaExceededError at write time is still authoritative. Never evict audio.
    },
    fingerprint: fingerprintFile,
    uuid: () => crypto.randomUUID(),
  };
}
