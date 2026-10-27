import { getUserData } from './users.js';

/** The address and greeting for a notification, or undefined for inactive users. */
export function recipient(userId) {
  const user = getUserData(userId);
  if (!user?.active) return undefined;
  return { to: user.username, greeting: `Hi ${user.name.split(' ')[0]},` };
}
