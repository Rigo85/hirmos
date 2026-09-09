import { deliverWithAckRetry } from './playback-command-delivery';

describe('deliverWithAckRetry', () => {
  it('retries a lost acknowledgement without changing the captured command id', async () => {
    const commandId = crypto.randomUUID();
    const deliveredIds: string[] = [];
    let attempt = 0;

    const result = await deliverWithAckRetry<{ status: string }>((ack) => {
      deliveredIds.push(commandId);
      attempt += 1;
      if (attempt === 2) ack({ status: 'duplicate' });
    }, {
      attempts: 2,
      ackTimeoutMs: 5,
      waitUntilReady: async () => true,
    });

    expect(result).toEqual({ status: 'duplicate' });
    expect(deliveredIds).toEqual([commandId, commandId]);
  });

  it('waits for transport readiness before delivering', async () => {
    let readinessChecks = 0;
    const send = vi.fn((ack: (value: string) => void) => ack('ok'));

    const result = await deliverWithAckRetry(send, {
      attempts: 2,
      ackTimeoutMs: 5,
      waitUntilReady: async () => ++readinessChecks === 2,
    });

    expect(result).toBe('ok');
    expect(readinessChecks).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
