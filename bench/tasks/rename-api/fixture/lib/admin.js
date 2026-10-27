import { getUserData } from './users.js';

/** A one-line summary for the admin console. */
export function describeUser(userId) {
  const user = getUserData(userId);
  if (!user) return `${userId}: unknown`;
  return `${user.id}: ${user.name} <${user.username}> (${user.plan}${user.active ? '' : ', inactive'})`;
}
