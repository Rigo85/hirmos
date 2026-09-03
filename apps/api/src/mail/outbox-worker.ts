import type { FastifyBaseLogger } from 'fastify';
import type { MailProvider } from './mail-provider.js';
import type { OutboxCipher } from './outbox-cipher.js';
import { OutboxRepository, type ClaimedOutboxMessage } from './outbox-repository.js';

const POLL_INTERVAL_MS = 5_000;

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private running = false;

  public constructor(
    private readonly repository: OutboxRepository,
    private readonly cipher: OutboxCipher,
    private readonly provider: MailProvider,
    private readonly logger: FastifyBaseLogger,
  ) {}

  public start(): void {
    if (this.timer || this.stopping) return;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.running) return;
    this.running = true;
    try {
      const message = await this.repository.claim();
      if (message) await this.deliver(message);
    } catch (error) {
      this.logger.error({ err: error }, 'Mail outbox iteration failed');
    } finally {
      this.running = false;
      if (!this.stopping) this.schedule(POLL_INTERVAL_MS);
    }
  }

  private async deliver(message: ClaimedOutboxMessage): Promise<void> {
    try {
      const data = this.cipher.decrypt(message.ciphertext, message.keyVersion);
      const recovery = message.type === 'password-recovery';
      const subject = recovery ? 'Recupera tu acceso a Hirmos' : 'Tu invitación a Hirmos';
      const action = recovery ? 'Restablecer contraseña' : 'Aceptar invitación';
      await this.provider.send({
        to: message.recipient,
        subject,
        text: `${data.display}\n\n${data.actionUrl}\n\nSi no esperabas este mensaje, puedes ignorarlo.`,
        html: `<p>${escapeHtml(data.display)}</p><p><a href="${escapeHtml(data.actionUrl)}">${action}</a></p><p>Si no esperabas este mensaje, puedes ignorarlo.</p>`,
      });
      await this.repository.markSent(message.id, message.lockId);
    } catch (error) {
      const code = safeErrorCode(error);
      await this.repository.markFailed(message.id, message.lockId, message.attempts, code);
      this.logger.warn({ outboxId: message.id, code }, 'Mail delivery failed');
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  const value = error as Record<string, unknown>;
  return typeof value['code'] === 'string' ? value['code'].slice(0, 80) : 'DELIVERY_FAILED';
}
