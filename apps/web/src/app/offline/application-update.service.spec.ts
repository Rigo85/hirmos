import { TestBed } from '@angular/core/testing';
import { SwUpdate, type VersionEvent, type UnrecoverableStateEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { ApplicationUpdateService } from './application-update.service';

function setup(enabled = true) {
  const versionUpdates = new Subject<VersionEvent>();
  const unrecoverable = new Subject<UnrecoverableStateEvent>();
  const activateUpdate = vi.fn(), checkForUpdate = vi.fn();
  TestBed.configureTestingModule({providers: [{provide: SwUpdate, useValue: {
    isEnabled: enabled, versionUpdates, unrecoverable, activateUpdate, checkForUpdate,
  }}]});
  return {service: TestBed.inject(ApplicationUpdateService), versionUpdates, unrecoverable, activateUpdate, checkForUpdate};
}
afterEach(() => TestBed.resetTestingModule());
it('reports a complete update without activating or forcing a reload', () => {
  const f = setup();
  f.versionUpdates.next({type:'VERSION_READY', currentVersion:{hash:'old'}, latestVersion:{hash:'new'}});
  expect(f.service.message()).toContain('no interrumpiremos');
  expect(f.activateUpdate).not.toHaveBeenCalled();
  expect(f.checkForUpdate).not.toHaveBeenCalled();
});
it('does not announce readiness from version detection alone', () => {
  const f = setup();
  f.versionUpdates.next({type:'VERSION_DETECTED', version:{hash:'new'}});
  expect(f.service.message()).toBe('');
});
it('reports failed and unrecoverable shell updates without clearing downloads', () => {
  const f = setup();
  f.versionUpdates.next({type:'VERSION_INSTALLATION_FAILED', version:{hash:'new'}, error:'network'});
  expect(f.service.message()).toContain('se conservan');
  f.unrecoverable.next({type:'UNRECOVERABLE_STATE', reason:'missing asset'});
  expect(f.service.message()).toContain('No borres los datos');
  expect(f.activateUpdate).not.toHaveBeenCalled();
});
it('works without a worker in unit tests and development', () => {
  const f = setup(false);
  f.versionUpdates.next({type:'VERSION_READY', currentVersion:{hash:'old'}, latestVersion:{hash:'new'}});
  expect(f.service.message()).toBe('');
});
