import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const apiOrigin = process.env.SMOKE_API_ORIGIN ?? 'http://127.0.0.1:3013';
const email = required('SMOKE_USER_EMAIL');
const password = required('SMOKE_USER_PASSWORD');
const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (login.status !== 200) throw new Error(`Login failed with HTTP ${login.status}`);
const setCookie = login.headers.get('set-cookie');
if (!setCookie) throw new Error('Login did not set a cookie');
const cookie = setCookie.split(';', 1)[0];
const discovered = await fetch(`${apiOrigin}/api/music/discover`, { headers: { cookie } });
if (discovered.status !== 200) throw new Error(`Discover failed with HTTP ${discovered.status}`);
const tracks = (await discovered.json()).tracks;
if (!Array.isArray(tracks) || tracks.length < 2) throw new Error('Discover returned fewer than two tracks');

const firstId = randomUUID();
const secondId = randomUUID();
const first = client(firstId, 'Smoke desktop');
const second = client(secondId, 'Smoke mobile');

try {
  const firstInitial = once(first, 'playback:snapshot');
  const secondInitial = once(second, 'playback:snapshot');
  first.connect();
  second.connect();
  const [initialA, initialB] = await Promise.all([firstInitial, secondInitial]);
  if (initialA.sessionId !== initialB.sessionId) throw new Error('Clients received different threads');

  let result = await command(first, 'playback:claim', {
    commandId: randomUUID(), expectedRevision: initialA.revision,
  });
  assertAccepted(result, 'first claim');
  if (result.snapshot.activeDeviceId !== firstId) throw new Error('First lease was not granted');

  result = await command(first, 'playback:select', {
    commandId: randomUUID(), expectedRevision: result.snapshot.revision, trackRef: tracks[0].id,
  });
  assertAccepted(result, 'first selection');
  result = await command(first, 'playback:select', {
    commandId: randomUUID(), expectedRevision: result.snapshot.revision, trackRef: tracks[1].id,
  });
  assertAccepted(result, 'second selection');
  if (result.snapshot.queue.length < 2) throw new Error('Queue was not persisted');

  result = await command(second, 'playback:control', {
    commandId: randomUUID(), expectedRevision: result.snapshot.revision, action: 'pause',
  });
  assertAccepted(result, 'remote pause');
  if (result.snapshot.status !== 'paused' || result.snapshot.activeDeviceId !== firstId) {
    throw new Error('Remote pause changed the wrong state or lease');
  }

  result = await command(second, 'playback:control', {
    commandId: randomUUID(), expectedRevision: result.snapshot.revision,
    action: 'seek', positionMs: 12_000,
  });
  assertAccepted(result, 'remote seek');
  if (result.snapshot.positionMs !== 12_000) throw new Error('Remote seek was not persisted');

  result = await command(second, 'playback:control', {
    commandId: randomUUID(), expectedRevision: result.snapshot.revision, action: 'previous',
  });
  assertAccepted(result, 'remote previous');
  if (result.snapshot.currentTrackRef !== tracks[0].id) throw new Error('Previous did not move in queue');

  const beforeTransfer = result.snapshot;
  result = await command(second, 'playback:claim', {
    commandId: randomUUID(), expectedRevision: beforeTransfer.revision,
  });
  assertAccepted(result, 'transfer');
  if (result.snapshot.activeDeviceId !== secondId) throw new Error('Lease transfer failed');

  const stale = await command(first, 'playback:update', {
    commandId: randomUUID(), expectedRevision: result.snapshot.revision,
    leaseEpoch: beforeTransfer.leaseEpoch, status: 'playing', positionMs: 50_000,
  });
  if (stale.status !== 'conflict') throw new Error('Previous lease owner was not rejected');

  const removeTarget = stale.snapshot.queue.find((item) => item.id !== stale.snapshot.currentQueueItemId);
  if (!removeTarget) throw new Error('No non-current queue item available for removal');
  result = await command(second, 'playback:queue-remove', {
    commandId: randomUUID(), expectedRevision: stale.snapshot.revision,
    queueItemId: removeTarget.id,
  });
  assertAccepted(result, 'queue removal');
  if (result.snapshot.queue.some((item) => item.id === removeTarget.id)) {
    throw new Error('Removed queue item is still active');
  }

  const duplicateId = randomUUID();
  const accepted = await command(second, 'playback:control', {
    commandId: duplicateId, expectedRevision: result.snapshot.revision, action: 'pause',
  });
  assertAccepted(accepted, 'idempotent command first attempt');
  const duplicate = await command(second, 'playback:control', {
    commandId: duplicateId, expectedRevision: result.snapshot.revision, action: 'pause',
  });
  if (duplicate.status !== 'duplicate') throw new Error('Duplicate command was not identified');

  console.log(JSON.stringify({
    status: 'ok',
    checks: [
      'single-user-thread', 'exclusive-lease', 'persistent-queue',
      'remote-pause', 'remote-seek', 'previous', 'lease-transfer',
      'old-owner-rejected', 'queue-removal', 'explicit-conflict', 'idempotency',
    ],
  }));
} finally {
  first.disconnect();
  second.disconnect();
}

function client(deviceId, deviceName) {
  return io(apiOrigin, {
    path: '/socket.io', autoConnect: false, transports: ['websocket'],
    extraHeaders: { cookie }, auth: { deviceId, deviceName, deviceType: 'desktop' },
  });
}

function command(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event} ack`)), 5000);
    socket.emit(event, payload, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

function assertAccepted(result, label) {
  if (result.status !== 'accepted') throw new Error(`${label}: received ${result.status}`);
}

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000);
    socket.once(event, (value) => { clearTimeout(timeout); resolve(value); });
    socket.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
