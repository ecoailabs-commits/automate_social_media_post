import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

const opt = (name, fallback = '') => process.env[name] ?? fallback;
const num = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);

export const config = {
  port: num('PORT', 3000),
  publicUrl: opt('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: path.resolve(opt('DATA_DIR', './data')),
  sessionSecret: required('SESSION_SECRET'),
  encryptionKey: required('ENCRYPTION_KEY'), // 64 hex chars (32 bytes)
  isProd: opt('NODE_ENV') === 'production',

  bootstrapAdmin: { email: opt('ADMIN_EMAIL'), password: opt('ADMIN_PASSWORD') },

  anthropic: {
    apiKey: opt('ANTHROPIC_API_KEY'),
    model: opt('ANTHROPIC_MODEL', 'claude-opus-5-5'),
  },
  groq: {
    apiKey: opt('GROQ_API_KEY'),
    model: opt('GROQ_MODEL', 'openai/gpt-oss-120b'),
  },

  meta: {
    appId: opt('META_APP_ID'),
    appSecret: opt('META_APP_SECRET'),
    apiVersion: opt('META_API_VERSION', 'v24.0'),
    configId: opt('META_CONFIG_ID'),
  },
  google: {
    clientId: opt('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: opt('GOOGLE_ADS_CLIENT_SECRET'),
    developerToken: opt('GOOGLE_ADS_DEVELOPER_TOKEN'),
    loginCustomerId: opt('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/-/g, ''),
    apiVersion: opt('GOOGLE_ADS_API_VERSION', 'v21'),
  },

  budget: {
    // Hard safety caps enforced server-side regardless of what the UI sends.
    maxDailyPerCampaign: num('MAX_DAILY_BUDGET_PER_CAMPAIGN', 500),
    maxTotalPerCampaign: num('MAX_TOTAL_BUDGET_PER_CAMPAIGN', 10000),
  },

  scheduler: {
    tickSeconds: num('SCHEDULER_TICK_SECONDS', 60),
    metricsSyncMinutes: num('METRICS_SYNC_MINUTES', 30),
    optimizeHours: num('AI_OPTIMIZE_EVERY_HOURS', 24),
  },

  notify: {
    smtpUrl: opt('SMTP_URL'),
    emailFrom: opt('NOTIFY_EMAIL_FROM'),
    emailTo: opt('NOTIFY_EMAIL_TO'),
    slackWebhook: opt('SLACK_WEBHOOK_URL'),
  },
};

// AI_PROVIDER picks explicitly; otherwise Groq is used when only a Groq key is set.
const provider = opt('AI_PROVIDER').toLowerCase() || (config.groq.apiKey && !config.anthropic.apiKey ? 'groq' : 'anthropic');
config.ai = {
  provider,
  configured: !!(provider === 'groq' ? config.groq.apiKey : config.anthropic.apiKey),
};

if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
  throw new Error('ENCRYPTION_KEY must be 64 hex characters (generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
}
