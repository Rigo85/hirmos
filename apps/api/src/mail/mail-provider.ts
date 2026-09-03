import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailProvider {
  send(message: MailMessage): Promise<void>;
}

export async function createSmtpMailProvider(config: AppConfig): Promise<MailProvider | null> {
  if (!config.SMTP_USER || !config.SMTP_APP_PASSWORD_FILE || !config.MAIL_FROM) return null;
  const password = (await readFile(config.SMTP_APP_PASSWORD_FILE, 'utf8')).trim();
  if (!password) throw new Error('SMTP app password file is empty');

  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: password },
  });
  return {
    async send(message): Promise<void> {
      await transport.sendMail({ from: config.MAIL_FROM, ...message });
    },
  };
}
