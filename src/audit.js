import { run } from './db.js';

/** Append an audit entry. `req` may be null for system actions (scheduler, rules). */
export function audit(req, action, entityType = null, entityId = null, details = null) {
  const user = req?.user;
  run(
    'INSERT INTO audit_logs (user_id, actor, action, entity_type, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    user?.id ?? null,
    user?.email ?? 'system',
    action,
    entityType,
    entityId == null ? null : String(entityId),
    details == null ? null : JSON.stringify(details),
    req?.ip ?? null,
  );
}
