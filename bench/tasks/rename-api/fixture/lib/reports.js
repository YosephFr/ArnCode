import { getUserData, userIds } from './users.js';

/** How many active users each plan has. */
export function planReport() {
  const counts = {};
  for (const id of userIds()) {
    const user = getUserData(id);
    if (user.active) counts[user.plan] = (counts[user.plan] ?? 0) + 1;
  }
  return counts;
}
