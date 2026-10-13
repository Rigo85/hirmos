import { Component, DestroyRef, InjectionToken, effect, inject, input, signal } from '@angular/core';
import { auditShell, fetchShellManifest, shellManifest } from './shell-audit';

const KEY='hirmos-public-shell-manifest-v1';
export interface ShellReadinessEnvironment {
  controlled():boolean;read():unknown;save(raw:unknown):void;fetch(signal:AbortSignal):Promise<unknown>;
  audit(manifest:ReturnType<typeof shellManifest>,signal:AbortSignal):Promise<boolean>;
}
export const SHELL_READINESS_ENVIRONMENT=new InjectionToken<ShellReadinessEnvironment>('shell audit',{
  providedIn:'root',factory:()=>({
    controlled:()=>navigator.serviceWorker?.controller?.scriptURL===new URL('/hirmos-worker.js',location.origin).href,
    read:()=>JSON.parse(localStorage.getItem(KEY)??'null'),save:raw=>localStorage.setItem(KEY,JSON.stringify(raw)),fetch:fetchShellManifest,
    audit:(manifest,signal)=>auditShell(manifest,caches,location.origin,signal),
  }),
});
@Component({selector:'app-shell-readiness',template:`
  <h3>Aplicación sin conexión</h3>
  <p>Comprueba que los archivos de la aplicación están guardados. La música se verifica por separado con «Verificar archivos».</p>
  <button class="outline-button" [disabled]="busy()" (click)="check()">{{busy()?'Comprobando…':'Comprobar aplicación offline'}}</button>
  @if(message()){<p role="status">{{message()}}</p>}
  <p class="muted">{{allowNetwork()?'Consulta únicamente el manifiesto público de Hirmos y revisa la copia local.':'Solo revisa datos locales; no hace peticiones de red.'}} El navegador puede eliminar datos después de esta comprobación.</p>
`})
export class ShellReadinessComponent {
  readonly allowNetwork=input(false);
  protected readonly busy=signal(false);protected readonly message=signal('Aún no comprobada en esta pantalla.');
  private readonly env=inject(SHELL_READINESS_ENVIRONMENT);private operation:AbortController|null=null;
  constructor(){
    effect(()=>{this.allowNetwork();this.operation?.abort();});
    inject(DestroyRef).onDestroy(()=>this.operation?.abort());
  }
  protected async check():Promise<void>{
    if(this.busy())return;this.busy.set(true);const controller=new AbortController();this.operation=controller;
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
    try{
      if(!this.env.controlled()){this.message.set('Esta pestaña aún no está controlada por Hirmos offline. Con conexión, espera la instalación y vuelve a abrir la aplicación cuando termines de escuchar.');return;}
      let raw:unknown=null,latest=false;try{raw=this.env.read();}catch{/* Public reference unavailable; online verification can still proceed. */}
      if(this.allowNetwork()){
        try{const fetched=await this.env.fetch(signal);shellManifest(fetched);raw=fetched;latest=true;}
        catch{signal.throwIfAborted();/* A network failure never erases a previously verified manifest. */}
      }
      signal.throwIfAborted();
      if(!raw){this.message.set('Falta una referencia del build para comprobarlo. Haz esta comprobación una vez en modo online. No significa que se hayan borrado tus descargas.');return;}
      const manifest=shellManifest(raw),complete=await this.env.audit(manifest,signal);signal.throwIfAborted();
      if(!complete){this.message.set('No pudimos confirmar una copia completa de la aplicación. Con conexión, deja terminar su preparación y comprueba de nuevo. Tus descargas no se modificaron.');return;}
      let saved=true;try{this.env.save(raw);}catch{saved=false;}
      this.message.set(`Archivos de la aplicación comprobados a las ${new Date().toLocaleTimeString()}. ${latest?'Corresponden al manifiesto consultado ahora.':'Se comprobó el último build registrado localmente; no se confirmó si hay una versión más nueva.'}${saved?'':' No pudimos guardar la referencia para la próxima comprobación.'}`);
    }catch{if(!controller.signal.aborted)this.message.set('No pudimos completar la comprobación. No se borraron datos ni se interrumpió la reproducción.');}
    finally{if(this.operation===controller){this.operation=null;this.busy.set(false);}}
  }
}
