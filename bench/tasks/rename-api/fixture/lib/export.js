import { getUserData, userIds } from './users.js';

/** CSV of all users for spreadsheets. */
export function usersCsv() {
  const rows = userIds().map((id) => {
    const user = getUserData(id);
    return [user.id, user.name, user.username, user.plan, user.active].join(',');
  });
  return ['id,name,username,plan,active', ...rows].join('\n');
}
