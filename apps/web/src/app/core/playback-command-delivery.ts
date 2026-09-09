export interface PlaybackDeliveryOptions {
  attempts?: number;
  ackTimeoutMs?: number;
  waitUntilReady: (timeoutMs: number) => Promise<boolean>;
  onTimeout?: (attempt: number, elapsedMs: number) => void;
}

/**
 * Retries delivery, not the logical command. The caller must capture one
 * commandId in `send`, so every attempt remains idempotent on the server.
 */
export async function deliverWithAckRetry<T>(
  send: (ack: (result: T) => void) => void,
  options: PlaybackDeliveryOptions,
): Promise<T | null> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 2));
  const ackTimeoutMs = Math.max(1, Math.floor(options.ackTimeoutMs ?? 6_000));
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!await options.waitUntilReady(ackTimeoutMs)) {
      options.onTimeout?.(attempt, Date.now() - startedAt);
      continue;
    }
    const result = await waitForAck(send, ackTimeoutMs);
    if (result !== null) return result;
    options.onTimeout?.(attempt, Date.now() - startedAt);
  }
  return null;
}

function waitForAck<T>(
  send: (ack: (result: T) => void) => void,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    try {
      send((result) => finish(result));
    } catch {
      finish(null);
    }
  });
}
