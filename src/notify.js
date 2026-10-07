import nodemailer from 'nodemailer';
import { config } from './config.js';
import { run } from './db.js';

const transport = config.notify.smtpUrl ? nodemailer.createTransport(config.notify.smtpUrl) : null;

/**
 * Record an in-app notification and fan out to email / Slack when configured.
 * External delivery failures are logged, never thrown — a notification must not break a deploy.
 */
export async function notify(level, title, body = '', campaignId = null) {
  run('INSERT INTO notifications (level, title, body, campaign_id) VALUES (?, ?, ?, ?)', level, title, body, campaignId);

  const link = campaignId ? `${config.publicUrl}/#/campaigns/${campaignId}` : config.publicUrl;
  const tasks = [];

  if (transport && config.notify.emailTo && (level === 'error' || level === 'warning' || level === 'success')) {
    tasks.push(
      transport.sendMail({
        from: config.notify.emailFrom || config.notify.emailTo,
        to: config.notify.emailTo,
        subject: `[AI Ads] ${title}`,
        text: `${body}\n\n${link}`,
      }),
    );
  }

  if (config.notify.slackWebhook) {
    const icon = { error: ':red_circle:', warning: ':warning:', success: ':white_check_mark:' }[level] ?? ':information_source:';
    tasks.push(
      fetch(config.notify.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${icon} *${title}*\n${body}\n<${link}|Open>` }),
      }).then((r) => { if (!r.ok) throw new Error(`Slack webhook HTTP ${r.status}`); }),
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === 'rejected') console.error('[notify] delivery failed:', r.reason?.message);
}
