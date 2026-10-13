import type {OfflineListen} from '@hirmos/contracts';

export interface ListenExecution {id:string;reference:string;startedAt:string}
/** Position deltas, not a playing timer. Seek explicitly rebases the meter. */
export class ListenMeter {
  private position=0;
  private mono=0;
  private wall=0;
  private execution:ListenExecution|null=null;
  constructor(private readonly emit:(report:OfflineListen)=>void){}
  start(execution:ListenExecution,position:number,mono:number,wall:number):void{
    this.execution=execution;this.rebase(position,mono,wall);
  }
  rebase(position:number,mono:number,wall:number):void{this.position=position;this.mono=mono;this.wall=wall;}
  sample(position:number,mono:number,wall:number):void{
    const elapsed=mono-this.mono,delta=position-this.position,wallElapsed=wall-this.wall;
    this.rebase(position,mono,wall);
    // Backward/forward seeks and a discontinuous system clock are not listening.
    if(!this.execution||!Number.isFinite(delta)||delta<=0||elapsed<0||delta>elapsed+250
      ||Math.abs(wallElapsed-elapsed)>2000)return;
    const heard=Math.floor(Math.min(delta,elapsed,Math.max(0,wall-Date.parse(this.execution.startedAt))));
    let from=wall-heard;
    while(from<wall){
      const midnight=(Math.floor(from/86400000)+1)*86400000;
      const end=Math.min(wall,from+60000,midnight);
      this.emit({id:crypto.randomUUID(),executionId:this.execution.id,reference:this.execution.reference,
        startedAt:this.execution.startedAt,at:new Date(end-1).toISOString(),heardMs:end-from});
      from=end;
    }
  }
  clear():void{this.execution=null;}
}
