const parseNumberEnv = (value: string | undefined, fallback: number): number =>
  value !== undefined && value !== '' ? Number(value) : fallback;

const parseListEnv = (value: string | undefined): string[] =>
  value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  site: {
    id: process.env.SITE_ID ?? 'default',
  },
  http: {
    port: Number(process.env.PORT ?? 3000),
    prefix: process.env.HTTP_PREFIX ?? 'api',
    redirectPort: process.env.HTTP_REDIRECT_PORT
      ? Number(process.env.HTTP_REDIRECT_PORT)
      : undefined,
  },
  https: {
    enabled:
      process.env.HTTPS_ENABLED === 'true' ||
      (!!process.env.HTTPS_KEY_PATH && !!process.env.HTTPS_CERT_PATH),
    keyPath: process.env.HTTPS_KEY_PATH,
    certPath: process.env.HTTPS_CERT_PATH,
    caPath: process.env.HTTPS_CA_PATH,
    passphrase: process.env.HTTPS_PASSPHRASE,
    active: false,
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  serial: {
    device: process.env.SERIAL_DEVICE,
    baudRate: process.env.SERIAL_BAUD ? Number(process.env.SERIAL_BAUD) : 115200,
    delimiter: process.env.SERIAL_DELIMITER ?? '\n',
    protocol: process.env.SERIAL_PROTOCOL ?? 'meshtastic-rewrite',
    ingestConcurrency: process.env.SERIAL_INGEST_CONCURRENCY
      ? Number(process.env.SERIAL_INGEST_CONCURRENCY)
      : 1,
    ingestBuffer: process.env.SERIAL_INGEST_BUFFER ? Number(process.env.SERIAL_INGEST_BUFFER) : 500,
    perTargetRate: process.env.SERIAL_PER_TARGET_RATE
      ? Number(process.env.SERIAL_PER_TARGET_RATE)
      : 8,
    globalRate: process.env.SERIAL_GLOBAL_RATE ? Number(process.env.SERIAL_GLOBAL_RATE) : 30,
    reconnectBaseMs: process.env.SERIAL_RECONNECT_BASE_MS
      ? Number(process.env.SERIAL_RECONNECT_BASE_MS)
      : 500,
    reconnectMaxMs: process.env.SERIAL_RECONNECT_MAX_MS
      ? Number(process.env.SERIAL_RECONNECT_MAX_MS)
      : 5000,
    reconnectJitter: process.env.SERIAL_RECONNECT_JITTER
      ? Number(process.env.SERIAL_RECONNECT_JITTER)
      : 0.3,
    reconnectMaxAttempts: process.env.SERIAL_RECONNECT_MAX_ATTEMPTS
      ? Number(process.env.SERIAL_RECONNECT_MAX_ATTEMPTS)
      : 0,
    clusterRole:
      (process.env.SERIAL_CLUSTER_ROLE as 'leader' | 'replica' | 'standalone' | undefined) ??
      'standalone',
    rpcTimeoutMs: process.env.SERIAL_RPC_TIMEOUT_MS
      ? Number(process.env.SERIAL_RPC_TIMEOUT_MS)
      : 8000,
  },
  websocket: {
    maxClients: process.env.WS_MAX_CLIENTS ? Number(process.env.WS_MAX_CLIENTS) : 200,
  },
  logging: {
    level: process.env.LOG_LEVEL ?? 'info',
    structured: process.env.STRUCTURED_LOGS !== 'false',
  },
  rateLimit: {
    defaultLimit: parseNumberEnv(process.env.RATE_LIMIT_DEFAULT_LIMIT, 300),
    defaultTtlSeconds: parseNumberEnv(process.env.RATE_LIMIT_DEFAULT_TTL, 60),
    form: {
      loginMinSubmitMs: parseNumberEnv(process.env.AUTH_MIN_SUBMIT_MS, 600),
    },
    rules: {
      'auth-login-burst': {
        limit: parseNumberEnv(process.env.RATE_LIMIT_LOGIN_BURST_LIMIT, 10),
        ttlSeconds: parseNumberEnv(process.env.RATE_LIMIT_LOGIN_BURST_TTL, 10),
      },
      'auth-login': {
        limit: parseNumberEnv(process.env.RATE_LIMIT_LOGIN_LIMIT, 30),
        ttlSeconds: parseNumberEnv(process.env.RATE_LIMIT_LOGIN_TTL, 60),
      },
      'auth-legal': {
        limit: parseNumberEnv(process.env.RATE_LIMIT_LEGAL_LIMIT, 20),
        ttlSeconds: parseNumberEnv(process.env.RATE_LIMIT_LEGAL_TTL, 300),
      },
      'auth-2fa': {
        limit: parseNumberEnv(process.env.RATE_LIMIT_2FA_LIMIT, 10),
        ttlSeconds: parseNumberEnv(process.env.RATE_LIMIT_2FA_TTL, 300),
      },
    },
  },
  mail: {
    enabled: process.env.MAIL_ENABLED !== 'false' && !!process.env.MAIL_HOST,
    host: process.env.MAIL_HOST,
    port: process.env.MAIL_PORT
      ? Number(process.env.MAIL_PORT)
      : process.env.MAIL_HOST
        ? process.env.MAIL_SECURE === 'true'
          ? 465
          : 587
        : undefined,
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
    secure: process.env.MAIL_SECURE === 'true',
    from: process.env.MAIL_FROM ?? 'Command Center <no-reply@command-center.local>',
    preview: process.env.MAIL_PREVIEW === 'true',
  },
  security: {
    invitationExpiryHours: process.env.INVITE_EXPIRY_HOURS
      ? Number(process.env.INVITE_EXPIRY_HOURS)
      : 48,
    passwordResetExpiryHours: process.env.PASSWORD_RESET_EXPIRY_HOURS
      ? Number(process.env.PASSWORD_RESET_EXPIRY_HOURS)
      : 4,
    appUrl: process.env.APP_URL ?? 'http://localhost:5173',
    alertRecipients: parseListEnv(process.env.SECURITY_ALERT_RECIPIENTS),
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiry: process.env.JWT_EXPIRY ?? '12h',
    twoFactor: {
      issuer: process.env.TWO_FACTOR_ISSUER ?? 'AntiHunter Command Center',
      tokenExpiry: process.env.TWO_FACTOR_TOKEN_EXPIRY ?? '10m',
      window: Number(process.env.TWO_FACTOR_WINDOW ?? 1),
      secretKeyConfigured: Boolean(process.env.TWO_FACTOR_SECRET_KEY),
    },
    lockout: {
      enabled: process.env.AUTH_LOCKOUT_ENABLED !== 'false',
      threshold: parseNumberEnv(process.env.AUTH_LOCKOUT_THRESHOLD, 5),
      durationMinutes: parseNumberEnv(process.env.AUTH_LOCKOUT_DURATION_MINUTES, 0),
      notify: parseListEnv(
        process.env.AUTH_LOCKOUT_NOTIFY ?? process.env.SECURITY_ALERT_RECIPIENTS,
      ),
    },
    anomaly: {
      requireTwoFactor: process.env.AUTH_ANOMALY_REQUIRE_2FA !== 'false',
      notify: parseListEnv(
        process.env.AUTH_ANOMALY_NOTIFY ?? process.env.SECURITY_ALERT_RECIPIENTS,
      ),
    },
  },
  tak: {
    enabled: process.env.TAK_ENABLED === 'true',
    protocol: process.env.TAK_PROTOCOL ?? 'UDP',
    host: process.env.TAK_HOST,
    port: process.env.TAK_PORT ? Number(process.env.TAK_PORT) : undefined,
    tlsEnabled: process.env.TAK_TLS === 'true',
    username: process.env.TAK_USERNAME,
    password: process.env.TAK_PASSWORD,
    apiKey: process.env.TAK_API_KEY,
  },
  faa: {
    onlineLookupEnabled: process.env.FAA_ONLINE_LOOKUP_ENABLED !== 'false',
    onlineCacheTtlMinutes: parseNumberEnv(process.env.FAA_ONLINE_CACHE_TTL_MINUTES, 60),
    onlineLookupCooldownMinutes: parseNumberEnv(process.env.FAA_ONLINE_LOOKUP_COOLDOWN_MINUTES, 10),
  },
  drones: {
    recordInventory: process.env.DRONES_RECORD_INVENTORY === 'true',
  },
  adsb: {
    enabled: process.env.ADSB_ENABLED === 'true',
    feedUrl: process.env.ADSB_FEED_URL ?? 'http://127.0.0.1:8080/data/aircraft.json',
    pollIntervalMs: parseNumberEnv(process.env.ADSB_POLL_INTERVAL_MS, 15000),
    geofencesEnabled: process.env.ADSB_GEOFENCES_ENABLED === 'true',
  },
  acars: {
    enabled: process.env.ACARS_ENABLED === 'true',
    udpHost: process.env.ACARS_UDP_HOST ?? '127.0.0.1',
    udpPort: parseNumberEnv(process.env.ACARS_UDP_PORT, 15550),
    messageExpiryMs: parseNumberEnv(process.env.ACARS_MESSAGE_EXPIRY_MS, 3600000),
  },
});
