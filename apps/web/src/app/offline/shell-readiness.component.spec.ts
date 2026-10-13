import {TestBed} from '@angular/core/testing';
import {ShellReadinessComponent,SHELL_READINESS_ENVIRONMENT} from './shell-readiness.component';
const manifest={index:'/index.html',assetGroups:[{installMode:'prefetch',urls:['/index.html']}],hashTable:{'/index.html':'a'.repeat(40)}};
function setup(network=false){
  const env={controlled:vi.fn(()=>true),read:vi.fn(()=>manifest as unknown),save:vi.fn(),fetch:vi.fn(async(_signal:AbortSignal)=>manifest),audit:vi.fn(async()=>true)};
  TestBed.configureTestingModule({imports:[ShellReadinessComponent],providers:[{provide:SHELL_READINESS_ENVIRONMENT,useValue:env}]});
  const f=TestBed.createComponent(ShellReadinessComponent);f.componentRef.setInput('allowNetwork',network);f.detectChanges();
  const check=async()=>{f.nativeElement.querySelector('button').click();await f.whenStable();f.detectChanges();};return {f,env,check};
}
afterEach(()=>TestBed.resetTestingModule());
it('never fetches in the offline island, but verifies local bytes',async()=>{
  const {f,env,check}=setup();expect(env.audit).not.toHaveBeenCalled();await check();
  expect(env.fetch).not.toHaveBeenCalled();expect(env.audit).toHaveBeenCalledOnce();expect(f.nativeElement.textContent).toContain('Archivos de la aplicación comprobados');
});
it('controller alone cannot prove readiness, nor can an incomplete build',async()=>{
  const {f,env,check}=setup(true);env.audit.mockResolvedValue(false);await check();
  expect(f.nativeElement.textContent).toContain('No pudimos confirmar');expect(env.save).not.toHaveBeenCalled();
  env.controlled.mockReturnValue(false);env.fetch.mockClear();await check();expect(env.fetch).not.toHaveBeenCalled();
  expect(f.nativeElement.textContent).toContain('aún no está controlada');
});
it('checks the last saved build when the public manifest is temporarily unavailable',async()=>{
  const {f,env,check}=setup(true);env.fetch.mockRejectedValue(new Error('network'));await check();
  expect(f.nativeElement.textContent).toContain('último build registrado');expect(env.audit).toHaveBeenCalledOnce();
});
it('does not infer a ready shell from downloads when there is no saved manifest',async()=>{
  const {f,env,check}=setup();env.read.mockReturnValue(null);await check();
  expect(env.audit).not.toHaveBeenCalled();expect(env.fetch).not.toHaveBeenCalled();expect(f.nativeElement.textContent).toContain('Falta una referencia');
});
it('aborts in-flight work when destroyed, without writes or reloads',async()=>{
  const {f,env}=setup(true);let resolve!:(value:typeof manifest)=>void;
  env.fetch.mockImplementation(()=>new Promise(done=>resolve=done));f.nativeElement.querySelector('button').click();
  const abortSignal=env.fetch.mock.calls[0]?.[0] as AbortSignal;f.destroy();expect(abortSignal.aborted).toBe(true);
  resolve(manifest);await Promise.resolve();await Promise.resolve();expect(env.save).not.toHaveBeenCalled();expect(env.audit).not.toHaveBeenCalled();
});
