import {Component,DestroyRef,effect,inject,signal} from '@angular/core';
import {SessionStore} from '../core/session.store';
import {LISTEN_OUTBOX} from './offline-listens.service';

/** Local diagnostics only; viewing this panel never triggers an upload. */
@Component({selector:'app-listen-report-status',template:`
  <h2>Reporte de escuchas offline</h2>
  <p>Solo se envía al volver al modo online con la misma cuenta. No modifica tu cola ni tus favoritos.</p>
  @if(summary();as value){<p>{{value.pending}} tramos pendientes de envío.
    @if(value.blocked){ {{value.blocked}} retenidos por un rechazo; requieren revisión técnica, no se reintentan automáticamente.}
  </p>}
  @if(error()){<p role="status">{{error()}}</p>}
`})
export class ListenReportStatusComponent {
  private readonly session=inject(SessionStore);
  private readonly outbox=inject(LISTEN_OUTBOX);
  protected readonly summary=signal<{pending:number;blocked:number}|null>(null);
  protected readonly error=signal('');
  private destroyed=false;
  private busy=false;
  private generation=0;
  constructor(){
    effect(()=>{const owner=this.session.localOwner();this.generation++;this.summary.set(null);this.error.set('');if(owner)void this.refresh();});
    const timer=setInterval(()=>void this.refresh(),15000);
    inject(DestroyRef).onDestroy(()=>{this.destroyed=true;clearInterval(timer);});
  }
  private async refresh():Promise<void>{
    const owner=this.session.localOwner(),generation=this.generation;if(!owner||this.busy||this.destroyed)return;
    this.busy=true;const valid=()=>!this.destroyed&&generation===this.generation&&owner===this.session.localOwner();
    try{const summary=await this.outbox.summary(owner);if(valid()){this.summary.set(summary);this.error.set('');}}
    catch{if(valid())this.error.set('No pudimos leer el reporte local. No se ha eliminado información.');}
    finally{this.busy=false;}
  }
}
