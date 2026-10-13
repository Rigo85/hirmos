import type { LocalSource } from './local-downloads';

export class DownloadFailure extends Error {
  constructor(readonly code: string, readonly retryAt = 0) { super(code); }
}
const recoverable = (status: number) => [408,425,429].includes(status) || status >= 500;
export function retryTime(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? Math.max(now,parsed) : 0;
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const done=()=>{signal.removeEventListener('abort',cancel);resolve();};
    const timer=setTimeout(done,ms);
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(signal.reason);};
    signal.addEventListener('abort',cancel,{once:true});
  });
}

/** Two header attempts share 30 seconds. A streamed body is never silently restarted. */
export async function downloadOriginal(reference: string, owner: string, signal: AbortSignal,
  progress: (bytes: number, total: number | null) => void): Promise<LocalSource> {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(reference)) throw new DownloadFailure('INVALID_REFERENCE');
  const deadline = Date.now()+30000;
  for (let attempt=0; attempt<2; attempt++) {
    signal.throwIfAborted();
    const controller=new AbortController();
    const abort=()=>controller.abort(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    let timer:ReturnType<typeof setTimeout>|undefined=setTimeout(()=>controller.abort(new DownloadFailure('TIMEOUT')),Math.max(1,Math.min(15000,deadline-Date.now())));
    let lifetime:ReturnType<typeof setTimeout>|undefined;
    const cleanup=()=>{clearTimeout(timer);clearTimeout(lifetime);signal.removeEventListener('abort',abort);};
    try {
      const response=await fetch(`/api/music/tracks/${encodeURIComponent(reference)}/download`,{
        credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
      });
      clearTimeout(timer);
      if (response.status!==200) {
        await response.body?.cancel().catch(()=>undefined);
        const retryAt=retryTime(response.headers.get('retry-after'));
        const failure=new DownloadFailure(`HTTP_${response.status}`,retryAt);
        if (!recoverable(response.status) || attempt===1) throw failure;
        cleanup();
        const wait=Math.max(400+Math.random()*300,retryAt-Date.now());
        if (Date.now()+wait+1000>=deadline) throw failure;
        await delay(wait,signal); continue;
      }
      if (response.headers.get('x-hirmos-account-id')!==owner) {
        await response.body?.cancel().catch(()=>undefined); throw new DownloadFailure('ACCOUNT_CHANGED');
      }
      const contentType=(response.headers.get('content-type')??'application/octet-stream').split(';')[0]!.trim();
      const length=response.headers.get('content-length');
      const expectedBytes=length===null ? null : Number(length);
      if (!response.body || !/^(audio\/[a-z0-9.+-]+|application\/(octet-stream|ogg))$/i.test(contentType)
        || (expectedBytes!==null && (!Number.isSafeInteger(expectedBytes)||expectedBytes<=0))) {
        await response.body?.cancel().catch(()=>undefined); throw new DownloadFailure('INVALID_RESPONSE');
      }
      const reader=response.body.getReader(); let bytes=0;
      const idle=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new DownloadFailure('TIMEOUT')),60000);};
      lifetime=setTimeout(()=>controller.abort(new DownloadFailure('TIMEOUT')),30*60000);
      idle(); progress(0,expectedBytes);
      return {contentType,expectedBytes,body:new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            controller.signal.throwIfAborted();
            const value=await reader.read();
            if (value.done) {
              if (!bytes || (expectedBytes!==null && bytes!==expectedBytes)) throw new DownloadFailure('TRUNCATED');
              cleanup();reader.releaseLock();target.close();return;
            }
            bytes+=value.value.byteLength;
            if (expectedBytes!==null && bytes>expectedBytes) throw new DownloadFailure('TRUNCATED');
            idle();progress(bytes,expectedBytes);target.enqueue(value.value);
          } catch(error) {cleanup();await reader.cancel().catch(()=>undefined);target.error(error);}
        },
        async cancel() {cleanup();controller.abort();await reader.cancel().catch(()=>undefined);},
      },{highWaterMark:0})};
    } catch(error) {
      cleanup();controller.abort();
      if (signal.aborted) throw signal.reason;
      if ((error instanceof DownloadFailure && error.code!=='TIMEOUT') || attempt===1 || Date.now()+1000>=deadline) throw error;
      await delay(400+Math.random()*300,signal);
    }
  }
  throw new DownloadFailure('NETWORK');
}

export function downloadMessage(error: unknown): string {
  const code=error instanceof Error ? error.message : '';
  if(error instanceof DOMException&&error.name==='AbortError')return 'Preparación cancelada. Tus descargas guardadas se conservan.';
  if(code==='FAVORITES_BUSY')return 'La descarga de Favoritos ya está en curso. Puedes gestionarla desde Descargas → Transferencias.';
  if(code==='FAVORITES_LIMIT')return 'La selección admite hasta 5.000 favoritos. No se guardó una selección parcial.';
  if(code==='FAVORITES_EMPTY')return 'No hay favoritos para descargar. Tus descargas anteriores se conservan.';
  if(code==='FAVORITES_UNAVAILABLE')return 'No pudimos obtener todas las pistas favoritas. No se guardó una selección incompleta; tus descargas anteriores se conservan.';
  if (code==='HTTP_401'||code==='ACCOUNT_CHANGED') return 'La sesión cambió o venció. Vuelve a entrar; tus archivos se conservan.';
  if (code==='HTTP_403') return 'Tu cuenta no tiene permiso para descargar esta pista.';
  if (code==='HTTP_404') return 'La pista ya no está disponible en la fuente. No se borran las otras descargas.';
  if (code==='HTTP_429') return 'El servicio pidió esperar antes de reintentar.';
  if (code.startsWith('HTTP_5')) return 'El servicio musical no está disponible. La descarga queda pendiente.';
  if (code==='SPACE_REQUIRED'||(error instanceof DOMException && error.name==='QuotaExceededError')) return 'No hay espacio suficiente. Libera espacio de forma explícita y reintenta; no hemos borrado otras descargas.';
  if (code==='UNSUPPORTED') return 'Este navegador no ofrece el almacenamiento necesario. Usa Chrome o Brave actualizado en un origen seguro.';
  if (code==='TRUNCATED'||code==='INVALID_LENGTH') return 'La transferencia quedó incompleta. Reintenta desde el principio; no figura como descargada.';
  if (code==='TIMEOUT'||(error instanceof DOMException&&error.name==='TimeoutError')) return 'La descarga dejó de responder. Puedes reintentar; las completadas se conservan.';
  if (code==='INVALID_RESPONSE') return 'La respuesta recibida no es un archivo de audio original válido.';
  if (code==='METADATA_INCOMPLETE') return 'No se pudieron actualizar todas las fichas. Los archivos se conservan; puedes reintentar más tarde.';
  if (code==='PLAYLIST_CHANGED'||code==='PLAN_CHANGED') return 'La lista cambió o está vacía. Actualízala antes de descargar; no guardamos una selección incompleta.';
  if (code==='PLAYLIST_UNAVAILABLE') return 'La playlist contiene pistas no disponibles. Revisa la lista antes de descargarla.';
  return 'No pudimos completar la operación. Conservamos lo guardado; revisa la conexión y vuelve a intentar.';
}
