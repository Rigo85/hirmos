import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';
import type { ThirdPartyTelemetry } from '../integrations/third-party-request.js';

export interface MailMessage {
  deliveryId: string;
  attempt: number;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailProvider {
  send(message: MailMessage): Promise<void>;
}

export async function createSmtpMailProvider(
  config: AppConfig,
  telemetry?: ThirdPartyTelemetry,
): Promise<MailProvider | null> {
  if (!config.SMTP_USER || !config.SMTP_APP_PASSWORD_FILE || !config.MAIL_FROM) return null;
  const password = (await readFile(config.SMTP_APP_PASSWORD_FILE, 'utf8')).trim();
  if (!password) throw new Error('SMTP app password file is empty');

  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    auth: { user: config.SMTP_USER, pass: password },
  });
  const messageDomain = mailDomain(config.MAIL_FROM);
  return {
    async send(message): Promise<void> {
      const startedAt = Date.now();
      const { deliveryId, attempt, ...content } = message;
      try {
        await transport.sendMail({
          from: config.MAIL_FROM,
          messageId: smtpMessageId(deliveryId, messageDomain),
          ...content,
        });
        telemetry?.record({
          provider: 'smtp', operation: 'send-mail', attempt, maxAttempts: 5,
          elapsedMs: Date.now() - startedAt, outcome: 'success',
        });
      } catch (error) {
        telemetry?.record({
          provider: 'smtp', operation: 'send-mail', attempt, maxAttempts: 5,
          elapsedMs: Date.now() - startedAt, outcome: 'failure',
          reason: mailErrorReason(error),
        });
        throw error;
      }
    },
  };
}

export function smtpMessageId(deliveryId: string, domain: string): string {
  return `<hirmos-${deliveryId}@${domain}>`;
}

function mailDomain(from: string): string {
  return from.match(/@([^>\s]+)>?\s*$/)?.[1]?.toLocaleLowerCase() ?? 'hirmos.invalid';
}

function mailErrorReason(error: unknown): 'network' | 'timeout' | 'unknown' {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
    if (typeof code === 'string' && code !== 'EAUTH') return 'network';
  }
  return 'unknown';
}
