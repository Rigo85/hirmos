import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createSmtpMailProvider } from '../src/mail/mail-provider.js';
import { ThirdPartyTelemetry } from '../src/integrations/third-party-request.js';

// Real Nodemailer transport against loopback only: no credentials or external mail.
for (const rejectAuth of [false, true]) {
  it(`SMTP transport ${rejectAuth ? 'reports rejection without delivering' : 'delivers MIME with stable identity'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-smtp-test-'));
    const sockets = new Set<Socket>(); const messages: string[] = []; const commands: string[] = [];
    const server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {}); socket.setEncoding('utf8');
      socket.write('220 fixture.example.test ESMTP\r\n');
      let buffer = ''; let body: string[] | null = null;
      socket.on('data', chunk => {
        buffer += chunk;
        while (buffer.includes('\r\n')) {
          const index = buffer.indexOf('\r\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (body !== null) {
            if (line === '.') { messages.push(body.join('\r\n')); body = null; socket.write('250 queued\r\n'); }
            else body.push(line);
          } else if (line.startsWith('EHLO')) socket.write('250-fixture.example.test\r\n250 AUTH PLAIN\r\n');
          else if (line.startsWith('AUTH')) socket.write(rejectAuth ? '535 Authentication rejected\r\n' : '235 Authenticated\r\n');
          else if (line === 'DATA') { body = []; socket.write('354 End with dot\r\n'); }
          else if (line === 'QUIT') socket.end('221 Bye\r\n');
          else { commands.push(line); socket.write('250 OK\r\n'); }
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
      const passwordFile = join(root, 'synthetic-password'); await writeFile(passwordFile, 'synthetic-only', { mode: 0o600 });
      const telemetry = new ThirdPartyTelemetry(); const events: unknown[] = [];
      telemetry.record = event => { events.push(event); };
      const provider = await createSmtpMailProvider(loadConfig({ NODE_ENV:'test', SMTP_HOST:'127.0.0.1',
        SMTP_PORT:String(address.port), SMTP_SECURE:'false', SMTP_USER:'synthetic@example.test',
        SMTP_APP_PASSWORD_FILE:passwordFile, MAIL_FROM:'Hirmos <sender@example.test>' }), telemetry);
      expect(provider).not.toBeNull();
      const send = () => provider!.send({ deliveryId:'synthetic-delivery', attempt:1, to:'listener@example.test',
        subject:'Synthetic recovery', text:'Synthetic text', html:'<p>Synthetic text</p>' });
      if (rejectAuth) {
        await expect(send()).rejects.toMatchObject({ code:'EAUTH' }); expect(messages).toEqual([]);
        expect(events).toEqual([expect.objectContaining({ provider:'smtp', outcome:'failure' })]);
      } else {
        await send(); expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('Message-ID: <hirmos-synthetic-delivery@example.test>');
        expect(messages[0]).toContain('multipart/alternative');
        expect(commands).toContain('RCPT TO:<listener@example.test>');
        expect(events).toEqual([expect.objectContaining({ provider:'smtp', outcome:'success' })]);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive:true, force:true });
    }
  });
}
