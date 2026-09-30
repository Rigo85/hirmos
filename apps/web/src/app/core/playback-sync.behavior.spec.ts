import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { PlaybackSnapshot, Track } from '@hirmos/contracts';
import { PlaybackSyncService } from './playback-sync.service';
import { AudioPlayerService } from './audio-player.service';
import { MediaSessionService } from './media-session.service';
import { SessionStore } from './session.store';
import { NEVER, of, throwError, Subject } from 'rxjs';

const socket = vi.hoisted(() => ({ connected: true, on: vi.fn(), off: vi.fn(),
  emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: () => socket }));

describe('PlaybackSyncService command consistency', () => {
  let service: PlaybackSyncService;
  let player: ReturnType<typeof makePlayer>;
  let current: PlaybackSnapshot;
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
  const receive = (s: PlaybackSnapshot) => {
    const callback = socket.on.mock.calls.find(([event]) => event === 'playback:snapshot')![1];
    callback(s);
  };
  const controls = () => socket.emit.mock.calls.filter(([event]) => event === 'playback:control');
  const faults = () => socket.emit.mock.calls.filter(([event]) => event === 'playback:failure');

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    socket.connected = true;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    sessionStorage.setItem('hirmos.player-id:user', '11111111-1111-4111-8111-111111111111');
    player = makePlayer();
    current = snapshot();
    TestBed.configureTestingModule({ providers: [
      PlaybackSyncService,
      { provide: HttpClient, useValue: { get: vi.fn(() => NEVER), post: vi.fn(() => of({tracks:[]})) } },
      { provide: AudioPlayerService, useValue: player },
      { provide: SessionStore, useValue: { session: signal({ user: { id: 'user' } }) } },
      { provide: MediaSessionService, useValue: {
        registerHandlers: vi.fn(), synchronize: vi.fn(), clear: vi.fn(),
      } },
    ] });
    service = TestBed.inject(PlaybackSyncService);
    // Use an empty queue for remote-command tests; local audio cases seed its
    // already-resolved metadata to avoid involving HTTP in this unit test.
    receive(current);
    await flush();
  });

  afterEach(() => {
    service.disconnect();
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries the identical payload even if a newer broadcast arrives before the acknowledgement', async () => {
    const command = service.next();
    await flush();
    const first = structuredClone(controls()[0][1]);
    const newer = { ...current, revision: 8, leaseEpoch: 4, playbackInstanceId: 'new-execution' };
    receive(newer);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(controls()).toHaveLength(2);
    expect(controls()[1][1]).toEqual(first);
    controls()[1][2]({ status: 'accepted', snapshot: { ...current, revision: 2 } });
    await command;
    expect(service.snapshot()).toEqual(newer);
  });

  it('does not rebase a conflict onto a different execution', async () => {
    const command = service.next();
    await flush();
    controls()[0][2]({ status: 'conflict', snapshot: {
      ...current, revision: 2, playbackInstanceId: 'another-execution',
    } });
    await command;
    expect(controls()).toHaveLength(1);
    expect(service.error()).toContain('otro dispositivo');
  });

  it('rebases only an unchanged target and keeps deliberate clicks in order', async () => {
    const first = service.next();
    const second = service.previous();
    await flush();
    expect(controls()).toHaveLength(1);
    controls()[0][2]({ status: 'conflict', snapshot: { ...current, revision: 2 } });
    await flush();
    expect(controls()[1][1].action).toBe('next');
    expect(controls()[1][1].commandId).not.toBe(controls()[0][1].commandId);
    controls()[1][2]({ status: 'accepted', snapshot: { ...current, revision: 3 } });
    await first;
    await flush();
    expect(controls()[2][1].action).toBe('previous');
    expect(controls()[2][1].expectedRevision).toBe(3);
    controls()[2][2]({ status: 'accepted', snapshot: { ...current, revision: 4 } });
    await second;
  });

  it('restarts the audio when the next queue entry references the same file', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    const local = { ...current, currentTrackRef: track.id,
      activeDeviceId: '11111111-1111-4111-8111-111111111111' };
    receive(local);
    await flush();
    player.seek.mockClear();
    receive({ ...local, revision: 2, currentQueueItemId: 'item-2', playbackInstanceId: 'run-2' });
    await flush();
    expect(player.seek).toHaveBeenCalledWith(0);
  });

  it('does not let a heartbeat retry pick up a later audio position', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    receive({ ...current, currentTrackRef: track.id,
      activeDeviceId: '11111111-1111-4111-8111-111111111111' });
    await flush();
    const publish = (service as unknown as { publishState(): Promise<void> }).publishState();
    await flush();
    const updates = () => socket.emit.mock.calls.filter(([event]) => event === 'playback:update');
    const first = structuredClone(updates()[0][1]);
    player.positionSeconds.set(42);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(updates()[1][1]).toEqual(first);
    updates()[1][2]({ status: 'accepted', snapshot: { ...service.snapshot()!, revision: 2 } });
    await publish;
  });

  it('stops the previous audio before metadata arrives and reports missing metadata once', async () => {
    const http = TestBed.inject(HttpClient);
    vi.mocked(http.get).mockReturnValue(throwError(() => ({status:404})));
    receive({...current,currentTrackRef:'missing',activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    expect(player.pause).toHaveBeenCalled();
    await flush();
    expect(player.resume).not.toHaveBeenCalled();
    expect(faults()).toHaveLength(1);
    expect(faults()[0][1].failure).toMatchObject({code:'not_found',phase:'metadata'});
    receive({...service.snapshot()!,revision:2});
    await flush();
    expect(faults()).toHaveLength(1);
    expect(player.resume).not.toHaveBeenCalled();
  });

  it('a playing snapshot never rearms an attempt already failed locally', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id,track);
    receive({...current,currentTrackRef:track.id,activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    player.resume.mockClear();
    player.onPlaybackFailed.mock.calls[0][0]('decode',{code:'decode',phase:'stream',positionMs:500,elapsedMs:0,requestId:null});
    await flush();
    receive({...service.snapshot()!,revision:2});
    await flush();
    expect(player.resume).not.toHaveBeenCalled();
    expect(faults()).toHaveLength(1);
    faults()[0][2]({status:'accepted',snapshot:{...service.snapshot()!,revision:3,status:'paused',renderPhase:'error'}});
    await flush();
    const command=service.retryCurrent();
    await flush();
    expect(controls().at(-1)![1].action).toBe('retry');
    controls().at(-1)![2]({status:'accepted',snapshot:{...service.snapshot()!,revision:4,status:'playing',renderPhase:'loading',attempt:1}});
    await command; await flush();
    expect(player.resume).toHaveBeenCalledOnce();
  });

  it('renews a loading execution without sending the previous track position as listening', async () => {
    vi.mocked(TestBed.inject(HttpClient).get).mockReturnValue(NEVER);
    player.positionSeconds.set(80);
    receive({...current,currentTrackRef:'loading',positionMs:1200,activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    const publish=(service as unknown as {publishState():Promise<void>}).publishState();
    await flush();
    const update=socket.emit.mock.calls.find(([event])=>event==='playback:update')!;
    expect(update[1]).toMatchObject({status:'playing',renderPhase:'buffering',positionMs:1200});
    update[2]({status:'accepted',snapshot:{...service.snapshot()!,revision:2}});
    await publish;
  });

  it('does not let a remote controller report an audio failure', async () => {
    player.onPlaybackFailed.mock.calls[0][0]('failure',{code:'decode',phase:'start',positionMs:0,elapsedMs:0,requestId:null});
    await flush();
    expect(faults()).toHaveLength(0);
  });

  it('preserves a concurrent pause while confirming failure, then retries explicitly with a new attempt', async () => {
    const diagnosis = new Subject<null>();
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    receive({ ...current, currentTrackRef: track.id, activeDeviceId: '11111111-1111-4111-8111-111111111111' });
    await flush();
    vi.mocked(TestBed.inject(HttpClient).get).mockReturnValue(diagnosis);
    player.onPlaybackFailed.mock.calls[0][0]('decode', {code:'decode',phase:'start',positionMs:0,elapsedMs:0,requestId:'diagnosis'});
    expect(service.unconfirmedFailure()?.code).toBe('decode');
    receive({ ...service.snapshot()!, revision:2, status:'paused', renderPhase:'paused' });
    diagnosis.next(null); diagnosis.complete(); await flush();
    expect(faults()[0][1].expectedRevision).toBe(2);
    faults()[0][2]({status:'accepted',snapshot:{...service.snapshot()!,revision:3,status:'paused',renderPhase:'error'}});
    await flush();
    expect(service.unconfirmedFailure()).toBeNull();
    expect(player.requested()).toBe(false);
    const resume = service.toggle(); await flush();
    expect(controls().at(-1)![1].action).toBe('retry');
    controls().at(-1)![2]({status:'accepted',snapshot:{...service.snapshot()!,revision:4,status:'playing',renderPhase:'loading',attempt:1}});
    await resume; await flush();
    expect(player.requested()).toBe(true);
  });

  it('does not hide an unconfirmed failure behind a successful but ineffective Play', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    receive({ ...current, currentTrackRef:track.id, activeDeviceId:'11111111-1111-4111-8111-111111111111' });
    await flush();
    player.onPlaybackFailed.mock.calls[0][0]('decode',{code:'decode',phase:'start',positionMs:0,elapsedMs:0,requestId:null});
    await flush();
    const rejected = () => ({status:'conflict',snapshot:{...service.snapshot()!,revision:2,status:'paused',renderPhase:'paused'},
      error:{code:'PLAYBACK_COMMAND_FAILED',message:'Please retry'}});
    faults()[0][2](rejected()); await flush();
    expect(service.unconfirmedFailure()).not.toBeNull();
    const retry = service.toggle(); await flush();
    expect(controls()).toHaveLength(0);
    expect(faults()).toHaveLength(2);
    faults()[1][2](rejected()); await retry;
    expect(player.requested()).toBe(false);
    expect(service.unconfirmedFailure()).not.toBeNull();
  });

  it('classifies partial batch failures without pretending missing results are absent', async () => {
    const batch = new Subject<unknown>();
    vi.mocked(TestBed.inject(HttpClient).post).mockReturnValue(batch);
    const loading = (service as unknown as {loadTracks(refs:string[]):Promise<void>}).loadTracks(['batch-track']);
    receive({...current,currentTrackRef:'batch-track',activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    batch.next({tracks:[],failures:[{reference:'batch-track',code:'service_unavailable',retryAfterMs:60000}]});
    batch.complete(); await loading; await flush();
    expect(faults()[0][1].failure).toMatchObject({code:'service_unavailable',retryAfterMs:60000});
  });

  it('does not restart a provider cooldown via another metadata request', async () => {
    const get = vi.mocked(TestBed.inject(HttpClient).get);
    get.mockReturnValue(throwError(() => ({status:503,headers:{get:()=> '60'},
      error:{failure:{reference:'unavailable',code:'service_unavailable',retryAfterMs:60000}}})));
    receive({...current,currentTrackRef:'unavailable',activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    expect(get).toHaveBeenCalledOnce();
    expect(faults()[0][1].failure).toMatchObject({code:'service_unavailable',retryAfterMs:60000});
    faults()[0][2]({status:'accepted',snapshot:{...service.snapshot()!,revision:2,status:'paused',renderPhase:'blocked'}});
    await flush();
    // The background queue resolver must obey the same cooldown as the owner.
    expect(TestBed.inject(HttpClient).post).not.toHaveBeenCalled();
    receive({...service.snapshot()!,revision:3}); await flush();
    expect(get).toHaveBeenCalledOnce();
    expect(TestBed.inject(HttpClient).post).not.toHaveBeenCalled();
  });

  it('resynchronizes an unacknowledged failure once, stays bounded, and keeps manual confirmation available', async () => {
    (service as unknown as {tracks:Map<string,Track>}).tracks.set(track.id,track);
    receive({...current,currentTrackRef:track.id,activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    player.onPlaybackFailed.mock.calls[0][0]('decode',{code:'decode',phase:'start',positionMs:0,elapsedMs:0,requestId:null});
    await vi.advanceTimersByTimeAsync(12001);
    expect(faults()).toHaveLength(2);
    expect(faults()[1][1]).toEqual(faults()[0][1]);
    receive({...service.snapshot()!,revision:2}); await flush();
    expect(faults()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(12001);
    receive({...service.snapshot()!,revision:3}); await flush();
    expect(faults()).toHaveLength(4);
    expect(service.unconfirmedFailure()).not.toBeNull();
    const manual=service.retryFailureReport(); await flush();
    expect(faults()).toHaveLength(5);
    faults()[4][2]({status:'accepted',snapshot:{...service.snapshot()!,revision:4,status:'paused',renderPhase:'error'}});
    await manual; expect(service.unconfirmedFailure()).toBeNull();
  });

  it('does not retry autoplay remotely or retry a provider before its cooldown expires', async () => {
    const notice={id:'notice',trackRef:track.id,code:'autoplay' as const,phase:'start' as const,
      positionMs:0,elapsedMs:0,occurredAt:new Date().toISOString(),outcome:'blocked' as const};
    receive({...current,currentTrackRef:track.id,renderPhase:'blocked',failures:[notice]});
    await service.retryCurrent();
    expect(controls()).toHaveLength(0);
    expect(service.error()).toContain('dispositivo');
    service.error.set(null);
    receive({...service.snapshot()!,revision:2,failures:[{...notice,code:'service_unavailable',retryAfterMs:60000}]});
    await service.retryCurrent();
    expect(controls()).toHaveLength(0);
    expect(service.error()).toBeNull();
    expect(service.retryWaitSeconds()).toBe(60);
  });

  it('restores only remaining cooldown, ticks without heartbeats and never retries automatically', async () => {
    (service as unknown as {tracks:Map<string,Track>}).tracks.set(track.id,track);
    const notice={id:'cooldown',trackRef:track.id,code:'service_unavailable' as const,phase:'start' as const,
      positionMs:0,elapsedMs:0,occurredAt:new Date(Date.now()-4_000).toISOString(),retryAfterMs:10_000,outcome:'blocked' as const};
    receive({...current,currentTrackRef:track.id,status:'paused',renderPhase:'blocked',failures:[notice]});
    expect(service.retryWaitSeconds()).toBe(6);
    await service.toggle(); expect(controls()).toHaveLength(0); expect(service.error()).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000); expect(service.retryWaitSeconds()).toBe(4);
    receive({...service.snapshot()!,revision:2}); expect(service.retryWaitSeconds()).toBe(4);
    await vi.advanceTimersByTimeAsync(4_000); expect(service.retryWaitSeconds()).toBe(0);
    expect(controls()).toHaveLength(0); expect(faults()).toHaveLength(0);
    const retry=service.toggle(); await flush();
    expect(controls()[0][1].action).toBe('retry');
    controls()[0][2]({status:'accepted',snapshot:{...service.snapshot()!,revision:3,attempt:1,status:'playing',renderPhase:'loading'}});
    await retry;
  });

  it('clears cooldown on a different track and on disconnect', async () => {
    const notice={id:'cooldown',trackRef:track.id,code:'service_unavailable' as const,phase:'start' as const,
      positionMs:0,elapsedMs:0,occurredAt:new Date().toISOString(),retryAfterMs:10_000,outcome:'blocked' as const};
    receive({...current,currentTrackRef:track.id,renderPhase:'blocked',failures:[notice]});
    expect(service.retryWaitSeconds()).toBe(10);
    receive({...service.snapshot()!,revision:2,currentTrackRef:'another',renderPhase:'playing'});
    expect(service.retryWaitSeconds()).toBe(0);
    receive({...service.snapshot()!,revision:3,currentTrackRef:track.id,renderPhase:'blocked'});
    expect(service.retryWaitSeconds()).toBe(10);
    service.disconnect(); expect(service.retryWaitSeconds()).toBe(0);
    await vi.advanceTimersByTimeAsync(11_000); expect(service.retryWaitSeconds()).toBe(0);
  });

  it('a server cooldown rejection stays neutral and does not automatically resend', async () => {
    (service as unknown as {tracks:Map<string,Track>}).tracks.set(track.id,track);
    const notice={id:'cooldown',trackRef:track.id,code:'service_unavailable' as const,phase:'start' as const,
      positionMs:0,elapsedMs:0,occurredAt:new Date(Date.now()-11_000).toISOString(),retryAfterMs:10_000,outcome:'blocked' as const};
    receive({...current,currentTrackRef:track.id,status:'paused',renderPhase:'blocked',failures:[notice]});
    const retry=service.retryCurrent(); await flush();
    controls()[0][2]({status:'conflict',snapshot:service.snapshot()!,error:{code:'RETRY_LATER',message:'wait'}});
    await retry;
    expect(service.error()).toBeNull(); expect(service.retryWaitSeconds()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.retryWaitSeconds()).toBe(0); expect(controls()).toHaveLength(1);
  });

  it('cancels a pending diagnostic on a new execution without reporting or blocking it', async () => {
    const diagnosis = new Subject<null>();
    (service as unknown as {tracks:Map<string,Track>}).tracks.set(track.id,track);
    receive({...current,currentTrackRef:track.id,activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    vi.mocked(TestBed.inject(HttpClient).get).mockReturnValue(diagnosis);
    player.onPlaybackFailed.mock.calls[0][0]('decode',{code:'decode',phase:'start',positionMs:0,elapsedMs:0,requestId:'request'});
    receive({...service.snapshot()!,revision:2,attempt:1}); await flush();
    diagnosis.next(null); diagnosis.complete(); await flush();
    expect(faults()).toHaveLength(0);
    expect(service.unconfirmedFailure()).toBeNull();
    expect(player.requested()).toBe(true);
  });

  it('cancels a pending failure when Next stops at the end, even though its item and attempt are unchanged', async () => {
    const diagnosis=new Subject<null>();
    (service as unknown as {tracks:Map<string,Track>}).tracks.set(track.id,track);
    receive({...current,currentTrackRef:track.id,activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    vi.mocked(TestBed.inject(HttpClient).get).mockReturnValue(diagnosis);
    player.onPlaybackFailed.mock.calls[0][0]('decode',{code:'decode',phase:'start',positionMs:0,elapsedMs:0,requestId:'request'});
    receive({...service.snapshot()!,revision:2,status:'stopped',renderPhase:'paused'});
    diagnosis.next(null); diagnosis.complete(); await flush();
    expect(service.unconfirmedFailure()).toBeNull();
    expect(faults()).toHaveLength(0);
    const replay=service.toggle(); await flush();
    expect(controls().at(-1)![1].action).toBe('play');
    controls().at(-1)![2]({status:'accepted',snapshot:{...service.snapshot()!,revision:3,status:'playing',renderPhase:'loading',playbackInstanceId:'new-run'}});
    await replay; await flush();
    expect(player.requested()).toBe(true);
  });

  it.each(['transfer', 'pause'])('permission gesture cannot resume after concurrent %s', async kind => {
    let finish!: () => void;
    player.resume.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    service.connected.set(true);
    receive({ ...current, status: 'paused', currentTrackRef: track.id, renderPhase: 'awaiting_interaction',
      activeDeviceId: '11111111-1111-4111-8111-111111111111' });
    await flush();
    const pending = service.continueAudio();
    expect(player.resume).toHaveBeenCalledOnce();
    receive({ ...service.snapshot()!, revision: 2, renderPhase: 'paused',
      ...(kind === 'transfer' ? { activeDeviceId: 'remote', leaseEpoch: 2 } : { attempt: 1 }) });
    await flush();
    finish(); await pending; await flush();
    expect(controls()).toHaveLength(0);
    expect(player.requested()).toBe(false);
    expect(service.continuingAudio()).toBe(false);
  });

  it('reports permission waiting without failure, retries, position extrapolation or duplicate diagnostics', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    receive({ ...current, currentTrackRef: track.id, positionMs: 12_000,
      activeDeviceId: '11111111-1111-4111-8111-111111111111' });
    await flush();
    player.waitForInteraction();
    player.onInteractionRequired.mock.calls[0][0]();
    await flush();
    const updates = socket.emit.mock.calls.filter(([event]) => event === 'playback:update');
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toMatchObject({status:'paused',renderPhase:'awaiting_interaction',positionMs:12_000});
    updates[0][2]({status:'accepted', snapshot:{...service.snapshot()!,revision:2,status:'paused',renderPhase:'awaiting_interaction'}});
    await flush();
    const calls = player.resume.mock.calls.length;
    receive({...service.snapshot()!,revision:3}); await flush();
    expect(player.resume).toHaveBeenCalledTimes(calls);
    expect(faults()).toHaveLength(0);
    expect(service.currentPositionSeconds(Date.now()+60_000)).toBe(12);
    expect(service.error()).toBeNull();
  });

  it('starts real audio inside the click and sends a fenced play only after native acceptance', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    service.connected.set(true);
    receive({...current,currentTrackRef:track.id,status:'paused',renderPhase:'awaiting_interaction',
      activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    const pending=service.continueAudio();
    expect(player.resume).toHaveBeenCalledOnce(); // synchronous before first await
    expect(controls()).toHaveLength(0);
    await flush();
    expect(controls()).toHaveLength(1);
    controls()[0][2]({status:'accepted',snapshot:{...service.snapshot()!,revision:2,status:'playing',renderPhase:'loading'}});
    await pending; await flush();
    expect(service.waitingForAudio()).toBe(false);
    expect(player.requested()).toBe(true);
  });

  it('a late conflicting permission acknowledgement cannot pause a newer execution', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    service.connected.set(true);
    receive({...current,currentTrackRef:track.id,status:'paused',renderPhase:'awaiting_interaction',
      activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    const pending=service.continueAudio();
    await flush();
    const oldAck=controls()[0][2];
    receive({...service.snapshot()!,revision:3,status:'playing',renderPhase:'loading',playbackInstanceId:'new-run'});
    await flush();
    player.pause.mockClear();
    oldAck({status:'conflict',snapshot:{...current,revision:2,status:'paused',renderPhase:'paused'}});
    await pending; await flush();
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.requested()).toBe(true);
  });

  it('persistent permission denial stays neutral and does not issue a play command', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    service.connected.set(true);
    receive({...current,currentTrackRef:track.id,status:'paused',renderPhase:'awaiting_interaction',
      activeDeviceId:'11111111-1111-4111-8111-111111111111'});
    await flush();
    player.resume.mockImplementationOnce(async () => {
      player.waitForInteraction();
      player.onInteractionRequired.mock.calls[0][0]();
    });
    await service.continueAudio(); await flush();
    expect(service.permissionStillBlocked()).toBe(true);
    expect(controls()).toHaveLength(0);
    expect(faults()).toHaveLength(0);
    expect(service.error()).toBeNull();
  });

  it('persists a dismissed incident per user without leaking it into another account', () => {
    const session = TestBed.inject(SessionStore).session as unknown as ReturnType<typeof signal<{user:{id:string}}>>;
    localStorage.setItem('hirmos.dismissed-incident.v1:other', 'other-incident');
    service.dismissedFailure.set('my-incident'); TestBed.tick();
    expect(localStorage.getItem('hirmos.dismissed-incident.v1:user')).toBe('my-incident');
    session.set({user:{id:'other'}}); TestBed.tick();
    expect(service.dismissedFailure()).toBe('other-incident');
    expect(localStorage.getItem('hirmos.dismissed-incident.v1:other')).toBe('other-incident');
    session.set({user:{id:'user'}}); TestBed.tick();
    expect(service.dismissedFailure()).toBe('my-incident');
    localStorage.removeItem('hirmos.dismissed-incident.v1:user');
    localStorage.removeItem('hirmos.dismissed-incident.v1:other');
  });

  it('shares the remaining failure budget with a pending metadata request', async () => {
    receive({ ...current, currentTrackRef: 'loading',
      activeDeviceId: '11111111-1111-4111-8111-111111111111',
      recoveryDeadline: new Date(Date.now() + 50).toISOString() });
    await vi.advanceTimersByTimeAsync(51);
    expect(faults()).toHaveLength(1);
    expect(faults()[0][1].failure).toMatchObject({ code: 'timeout', phase: 'metadata', elapsedMs: 50 });
    expect(player.resume).not.toHaveBeenCalled();
  });

  // A native permission denial is NOT simulated by this unit test; that is
  // exercised separately by the local browser fixture with actual media.
  it('reload regression: prepares the current source while waiting for audio permission', async () => {
    player.track.set(null as unknown as Track);
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    receive({ ...current, currentTrackRef: track.id, status: 'paused', renderPhase: 'awaiting_interaction',
      activeDeviceId: '11111111-1111-4111-8111-111111111111', failures: [{
        id: 'reload-permission', code: 'autoplay', phase: 'start', positionMs: 12_000, elapsedMs: 0,
        trackRef: track.id, occurredAt: new Date().toISOString(), outcome: 'blocked',
      }] });
    await flush();
    expect(player.resume).not.toHaveBeenCalled();
    expect(player.load).toHaveBeenCalledWith(track);
  });

  it('classifies an expired authenticated diagnostic as a global block, not an isolated track', async () => {
    (service as unknown as { tracks: Map<string, Track> }).tracks.set(track.id, track);
    receive({ ...current, currentTrackRef: track.id, activeDeviceId: '11111111-1111-4111-8111-111111111111' });
    await flush();
    vi.mocked(TestBed.inject(HttpClient).get).mockReturnValue(throwError(() => ({ status: 401 })));
    player.onPlaybackFailed.mock.calls[0][0]('failure', {
      code: 'unsupported', phase: 'start', positionMs: 0, elapsedMs: 0, requestId: 'request',
    });
    await flush();
    expect(faults()[0][1].failure.code).toBe('authentication');
  });
});

function snapshot(): PlaybackSnapshot {
  return { protocolVersion: 3, attempt: 0, renderPhase: 'unknown', failures: [], recoveryDeadline: null, sessionId: 'session', revision: 1, queueRevision: 1,
    playbackInstanceId: 'run-1', currentQueueItemId: 'item-1', currentTrackRef: null,
    status: 'playing', positionMs: 0, positionObservedAt: new Date().toISOString(),
    activeDeviceId: 'remote', leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), queue: [] };
}
const track = { id: 'track' } as Track;
function makePlayer() {
  const player = { track: signal(track), playing: signal(true), positionSeconds: signal(0),
    durationSeconds: signal(180), requested: signal(true), phase: signal('playing'),
    pause: vi.fn(), seek: vi.fn(), load: vi.fn(), setRecoveryDeadline: vi.fn(),
    resume: vi.fn(async (): Promise<void> => undefined),
    onEnded: vi.fn(), onPlaybackStarted: vi.fn(), onPlaybackFailed: vi.fn(), onRecoveryCheck: vi.fn(),
    onInteractionRequired: vi.fn(), waitForInteraction: vi.fn() };
  player.pause.mockImplementation(() => { player.requested.set(false); player.playing.set(false); });
  player.seek.mockImplementation((seconds: number) => player.positionSeconds.set(seconds));
  player.resume.mockImplementation(async () => { player.requested.set(true); player.phase.set('buffering'); });
  player.waitForInteraction.mockImplementation(() => { player.pause(); player.phase.set('awaiting_interaction'); });
  return player;
}
