import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SITE_ID: z.string().optional(),
  ALLOW_FOREVER: z.string().optional(),
  ALLOW_ERASE_FORCE: z.string().optional(),
  PORT: z
    .string()
    .default('3000')
    .transform((val) => Number(val))
    .pipe(z.number().int().min(0).max(65535)),
  HTTP_PREFIX: z.string().default('api'),
  HTTP_REDIRECT_PORT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).max(65535).optional()),
  HTTPS_ENABLED: z.string().optional(),
  HTTPS_KEY_PATH: z.string().optional(),
  HTTPS_CERT_PATH: z.string().optional(),
  HTTPS_CA_PATH: z.string().optional(),
  HTTPS_PASSPHRASE: z.string().optional(),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  STRUCTURED_LOGS: z
    .string()
    .optional()
    .transform((val) => (val ? val !== 'false' : true)),
  SERIAL_DEVICE: z.string().optional(),
  SERIAL_BAUD: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  SERIAL_DELIMITER: z.string().optional(),
  SERIAL_PROTOCOL: z.enum(['meshtastic-rewrite', 'raw-lines', 'nmea-like']).optional(),
  SERIAL_PER_TARGET_RATE: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  SERIAL_GLOBAL_RATE: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  SERIAL_RECONNECT_BASE_MS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).optional()),
  SERIAL_RECONNECT_MAX_MS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).optional()),
  SERIAL_RECONNECT_JITTER: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().min(0).max(1).optional()),
  SERIAL_RECONNECT_MAX_ATTEMPTS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).optional()),
  SERIAL_CLUSTER_ROLE: z.enum(['leader', 'replica', 'standalone']).optional(),
  SERIAL_RPC_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1000).optional()),
  WS_MAX_CLIENTS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  MAIL_ENABLED: z.string().optional(),
  MAIL_HOST: z.string().optional(),
  MAIL_PORT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  MAIL_USER: z.string().optional(),
  MAIL_PASS: z.string().optional(),
  MAIL_SECURE: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  MAIL_PREVIEW: z.string().optional(),
  RATE_LIMIT_DEFAULT_LIMIT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_DEFAULT_TTL: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_LOGIN_BURST_LIMIT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_LOGIN_BURST_TTL: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_LOGIN_LIMIT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_LOGIN_TTL: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_LEGAL_LIMIT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_LEGAL_TTL: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_2FA_LIMIT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  RATE_LIMIT_2FA_TTL: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(1).optional()),
  AUTH_MIN_SUBMIT_MS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).optional()),
  INVITE_EXPIRY_HOURS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  PASSWORD_RESET_EXPIRY_HOURS: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  JWT_SECRET: z.string().optional(),
  JWT_EXPIRY: z.string().optional(),
  TWO_FACTOR_ISSUER: z.string().optional(),
  TWO_FACTOR_WINDOW: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().min(0).max(4).optional()),
  TWO_FACTOR_TOKEN_EXPIRY: z.string().optional(),
  TWO_FACTOR_SECRET_KEY: z.string().optional(),
  APP_URL: z.string().optional(),
  TAK_ENABLED: z.string().optional(),
  TAK_PROTOCOL: z.enum(['UDP', 'TCP', 'HTTPS']).optional(),
  TAK_HOST: z.string().optional(),
  TAK_PORT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .pipe(z.number().int().positive().optional()),
  TAK_TLS: z.string().optional(),
  TAK_USERNAME: z.string().optional(),
  TAK_PASSWORD: z.string().optional(),
  TAK_API_KEY: z.string().optional(),
});

export type EnvironmentVariables = z.infer<typeof envSchema>;

export function validateEnvironment(config: Record<string, unknown>): EnvironmentVariables {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const formatted = parsed.error.flatten();
    throw new Error(
      `Invalid environment configuration: ${JSON.stringify(formatted.fieldErrors, null, 2)}`,
    );
  }

  return parsed.data;
}
