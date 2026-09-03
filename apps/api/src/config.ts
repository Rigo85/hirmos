import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3013),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  PUBLIC_ORIGIN: z.url().default('http://localhost:4200'),
  TRUSTED_PROXIES: z.string().default('127.0.0.1').transform((value) =>
    value.split(',').map((item) => item.trim()).filter(Boolean),
  ),
  DATABASE_URL: z.string().min(1).optional(),
  DATA_ENCRYPTION_KEY: z.string().min(1).optional(),
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
  SMTP_SECURE: booleanFromString.default(true),
  SMTP_USER: z.string().optional(),
  SMTP_APP_PASSWORD_FILE: z.string().optional(),
  MAIL_FROM: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(source);
  if (!result.success) {
    const message = z.prettifyError(result.error);
    throw new Error(`Invalid Hirmos configuration:\n${message}`);
  }
  return result.data;
}
