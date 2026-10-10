import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import './db.js';
import { bootstrapAdmin, csrfGuard, sessionMiddleware } from './auth.js';
import authRoutes from './routes/auth.js';
import connectionRoutes from './routes/connections.js';
import campaignRoutes from './routes/campaigns.js';
import miscRoutes from './routes/misc.js';
import { startScheduler } from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
if (config.isProd) app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    // Meta's live preview is an iframe from facebook.com; everything else is same-origin.
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; frame-src https://www.facebook.com https://*.facebook.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);
app.use('/api', csrfGuard);
app.use('/api', authRoutes, connectionRoutes, campaignRoutes, miscRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

bootstrapAdmin();
app.listen(config.port, () => startScheduler());
