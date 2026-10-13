import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {ListenReportStatusComponent} from './listen-report-status.component';
import {LISTEN_OUTBOX} from './offline-listens.service';
import {SessionStore} from '../core/session.store';

it('shows pending/rejected reports from local storage without a network service',async()=>{
  const summary=vi.fn(async()=>({pending:3,blocked:1}));
  TestBed.configureTestingModule({imports:[ListenReportStatusComponent],providers:[
    {provide:SessionStore,useValue:{localOwner:signal('a')}},{provide:LISTEN_OUTBOX,useValue:{summary}}]});
  const f=TestBed.createComponent(ListenReportStatusComponent);f.detectChanges();await f.whenStable();f.detectChanges();
  expect(summary).toHaveBeenCalledWith('a');expect(f.nativeElement.textContent).toContain('3 tramos pendientes');
  expect(f.nativeElement.textContent).toContain('1 retenidos');
});
it('ignores a late inventory belonging to a previous account',async()=>{
  let release!:(value:{pending:number;blocked:number})=>void;const owner=signal('a');
  const summary=vi.fn(()=>new Promise<{pending:number;blocked:number}>(r=>release=r));
  TestBed.configureTestingModule({imports:[ListenReportStatusComponent],providers:[
    {provide:SessionStore,useValue:{localOwner:owner}},{provide:LISTEN_OUTBOX,useValue:{summary}}]});
  const f=TestBed.createComponent(ListenReportStatusComponent);f.detectChanges();owner.set('b');f.detectChanges();
  release({pending:987,blocked:0});await f.whenStable();f.detectChanges();
  expect(f.nativeElement.textContent).not.toContain('987');
});
