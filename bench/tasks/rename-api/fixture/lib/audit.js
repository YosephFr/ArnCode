import { getUserData } from './users.js';

const events = [];

/** Record who did what, keeping the actor's username at the time. */
export function audit(userId, action) {
  const actor = getUserData(userId);
  events.push({ actor: actor?.username ?? 'unknown', action, at: events.length });
  return events.at(-1);
}

export function auditLog() {
  return [...events];
}
