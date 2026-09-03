import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import argon2 from 'argon2';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { PostgresAuthRepository } from './auth-repository.js';

const config = loadConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');

const email = process.env.HIRMOS_BOOTSTRAP_EMAIL?.trim().toLowerCase();
if (!email) throw new Error('HIRMOS_BOOTSTRAP_EMAIL is required');

const terminal = createInterface({ input: stdin, output: stdout });
const password = stdin.isTTY
  ? await readHiddenPassword('Initial admin password: ')
  : await terminal.question('Initial admin password: ');
terminal.close();

if (password.length < 12) {
  throw new Error('The initial admin password must contain at least 12 characters');
}

const database = createDatabase(config.DATABASE_URL);
try {
  const repository = new PostgresAuthRepository(database);
  const existing = await repository.findPasswordUserByEmail(email);
  if (existing) throw new Error('An account with that email already exists');
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const user = await repository.createUser({
    email,
    displayName: email.split('@')[0] || 'Administrador',
    role: 'admin',
    passwordHash,
  });
  stdout.write(`Created initial admin ${user.email}\n`);
} finally {
  await database.close();
}

function readHiddenPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Bootstrap cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.on('data', onData);
  });
}
