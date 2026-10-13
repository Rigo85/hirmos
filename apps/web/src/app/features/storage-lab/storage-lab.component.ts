import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { browserDownloadStorage } from '../../offline/browser-download-storage';
import { LocalDownloads, type LocalDownload } from '../../offline/local-downloads';

const namespace = 'hirmos-downloads-lab-storage-v1';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const track = {reference:'c3ludGhldGljLXByaW1hcnk',title:'Archivo sintético',artist:'Laboratorio',album:'No es música real'};
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const source = (bytes: Uint8Array) => async () => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(bytes.subarray(0,13)); controller.enqueue(bytes.subarray(13)); controller.close(); },
});

@Component({
  selector:'app-storage-lab', imports:[RouterLink],
  template: `<main class="account-ui">
    <a routerLink="/">← Volver al reproductor</a>
    <p class="eyebrow">LABORATORIO LOCAL · DATOS SINTÉTICOS</p>
    <h1>Almacenamiento de descargas</h1>
    <p>Prueba del inventario y los archivos del navegador. No descarga música real, no toca tu cola y no activa el modo offline.</p>
    <p>«Ejecutar pruebas» sustituye solo los datos sintéticos de este laboratorio. Las futuras descargas reales usan otro espacio.</p>
    <div class="actions">
      <button class="primary-button" [disabled]="busy()" (click)="run()">{{busy() ? 'Comprobando…' : 'Ejecutar pruebas'}}</button>
      <button class="outline-button" [disabled]="busy()" (click)="inspect()">Inspeccionar lo guardado</button>
    </div>
    @if(error()) { <p class="error" role="alert">{{error()}}</p> }
    <ol aria-live="polite">@for(result of results(); track $index) { <li>{{result}}</li> }</ol>
    @if(inspected()) {
      <h2>Inventario sintético de esta cuenta</h2>
      <p>Archivos registrados: {{records().length}} · Objetos sin adoptar: {{unclaimed()}} (no se borran automáticamente).</p>
      <ul>@for(record of records(); track record.track.reference) {
        <li><strong>{{record.track.title}}</strong> · {{labels[record.state]}} · {{record.bytes}} bytes</li>
      }</ul>
      <p>Puedes recargar la página y pulsar «Inspeccionar lo guardado» para comprobar que persiste. La inspección verifica las huellas, no consulta la red.</p>
    }
    <p class="muted">Sin botones de descarga en la biblioteca ni reproducción offline todavía. Esta prueba no demuestra persistencia bajo todas las políticas de Android o Brave.</p>
  </main>`,
  styles:`:host{display:block}main{max-width:960px;margin:0 auto;padding:40px 24px}h1{font-size:36px;margin:20px 0}p,li{line-height:1.65}li{margin:12px 0}.actions{display:flex;gap:16px;flex-wrap:wrap;margin:28px 0}button{width:auto;padding:12px 20px}.actions .primary-button{margin-top:0}.error{color:#ffb4b4}.muted{color:var(--muted);border-top:1px solid var(--line);padding-top:20px;margin-top:32px}h2{margin-top:32px}@media(max-width:500px){.actions{flex-direction:column}h1{font-size:28px}}`,
})
export class StorageLabComponent {
  protected readonly busy=signal(false);
  protected readonly error=signal('');
  protected readonly results=signal<string[]>([]);
  protected readonly records=signal<LocalDownload[]>([]);
  protected readonly unclaimed=signal(0);
  protected readonly inspected=signal(false);
  protected readonly labels={writing:'Escribiendo',ready:'Verificado',interrupted:'Interrumpido',missing:'Archivo ausente',corrupt:'Archivo dañado',deleting:'Eliminando',deleted:'Eliminado'};
  private guard(): void {
    if (!['localhost','127.0.0.1','[::1]'].includes(location.hostname)) throw new Error('Solo disponible en laboratorio local.');
  }
  private pass(message: string): void { this.results.update(list=>[...list,`✓ ${message}`]); }
  private async load(): Promise<void> {
    const state=await new LocalDownloads(owner,browserDownloadStorage(namespace)).reconcile(true);
    this.records.set(state.records); this.unclaimed.set(state.unclaimed); this.inspected.set(true);
  }
  protected async inspect(): Promise<void> {
    if(this.busy()) return; this.busy.set(true); this.error.set('');
    try { this.guard(); await navigator.locks.request(namespace+':test-run',()=>this.load()); }
    catch(error) { this.error.set(error instanceof Error ? error.message : 'No se pudo leer el almacenamiento local.'); }
    finally { this.busy.set(false); }
  }
  protected async run(): Promise<void> {
    if(this.busy()) return; this.busy.set(true); this.results.set([]); this.error.set('');
    try {
      this.guard();
      // This lock also protects the destructive synthetic reset against a second lab tab.
      await navigator.locks.request(namespace+':test-run',async()=>{
        await this.resetSynthetic();
        const ports=browserDownloadStorage(namespace);
        const store=new LocalDownloads(owner,ports);
        const bytes=new Uint8Array(1024*1024+17); for(let i=0;i<bytes.length;i++) bytes[i]=i%251;
        let calls=0;
        const fetch=async()=>{calls++;return source(bytes)();};
        const [saved,duplicate]=await Promise.all([
          store.save(track,'audio/flac',bytes.length,fetch),
          new LocalDownloads(owner,browserDownloadStorage(namespace)).save(track,'audio/flac',bytes.length,fetch),
        ]);
        assert(saved.state==='ready' && saved.fileId===duplicate.fileId && calls===1,'Falló exclusión/descarga única');
        this.pass('Archivo verificado; dos instancias concurrentes descargan una sola vez.');
        assert((await new LocalDownloads(other,ports).list()).length===0,'Aislamiento de cuentas falló');
        this.pass('Otra cuenta no ve estos archivos.');
        await this.removeIndexRecord(track.reference);
        assert((await store.reconcile()).records.some(r=>r.fileId===saved.fileId && r.state==='ready'),'No reconstruyó índice');
        this.pass('Inventario perdido recuperado desde manifiesto y archivo verificado.');
        const crashTrack={...track,reference:'c3ludGhldGljLWNyYXNo',title:'Copia recuperada tras corte'};
        const crashStore=new LocalDownloads(owner,{...ports,index:{...ports.index,put:async row=>{
          if(row.state==='ready') throw new Error('Corte sintético antes de commit de índice'); await ports.index.put(row);
        }}});
        try {await crashStore.save(crashTrack,'audio/flac',bytes.length,source(bytes));} catch { /* expected */ }
        assert((await store.reconcile()).records.some(r=>r.track.reference===crashTrack.reference && r.state==='ready'),'No recuperó corte');
        this.pass('Corte entre archivo e inventario recuperado sin redescargar.');
        const missingTrack={...track,reference:'c3ludGhldGljLW1pc3Npbmc',title:'Prueba de archivo ausente'};
        const missing=await store.save(missingTrack,'audio/flac',bytes.length,source(bytes));
        await (await this.syntheticObject(missing.fileId)).removeEntry('audio');
        assert((await store.check(missingTrack.reference))?.state==='missing','No detectó ausencia');
        this.pass('Archivo eliminado detectado; el inventario no finge disponibilidad.');
        const corrupt=bytes.slice(); corrupt[100]^=255;
        await ports.files.write(owner,saved.fileId,await source(corrupt)());
        assert((await store.check(track.reference,true))?.state==='corrupt','No detectó corrupción');
        this.pass('Cambio de bytes con el mismo tamaño detectado mediante huella.');
        const partial={...track,reference:'c3ludGhldGljLXBhcnRpYWw',title:'Prueba de transferencia incompleta'};
        try {await store.save(partial,'audio/flac',bytes.length+1,source(bytes));} catch { /* expected */ }
        assert((await store.check(partial.reference))?.state==='interrupted','Publicó parcial');
        this.pass('Transferencia incompleta permanece interrumpida, nunca lista.');
        await this.load();
      });
    } catch(error) {this.error.set(error instanceof Error ? error.message : 'No se pudo completar la prueba.');}
    finally {this.busy.set(false);}
  }
  private async syntheticObject(id: string): Promise<FileSystemDirectoryHandle> {
    const root=await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace);
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(owner)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    return (await root.getDirectoryHandle(hash)).getDirectoryHandle(id);
  }
  private async removeIndexRecord(reference: string): Promise<void> {
    await new Promise<void>((resolve,reject)=>{
      const open=indexedDB.open(namespace,2);
      open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{
        const db=open.result; const tx=db.transaction('downloads','readwrite');
        tx.objectStore('downloads').delete([owner,reference]);
        tx.oncomplete=()=>{db.close();resolve();}; tx.onabort=()=>{db.close();reject(tx.error);};
      };
    });
  }
  private async resetSynthetic(): Promise<void> {
    const root=await navigator.storage.getDirectory();
    try {await root.removeEntry(namespace,{recursive:true});}
    catch(error) {if(!(error instanceof DOMException && error.name==='NotFoundError')) throw error;}
    await new Promise<void>((resolve,reject)=>{
      const request=indexedDB.deleteDatabase(namespace);
      request.onsuccess=()=>resolve(); request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('Cierra la otra pestaña de laboratorio y reintenta.'));
    });
  }
}
