import { getUserData, userIds } from './users.js';

/** Users whose name or username contains the query, ignoring case. */
export function searchUsers(query) {
  const needle = query.toLowerCase();
  return userIds()
    .map((id) => getUserData(id))
    .filter((user) => `${user.name} ${user.username}`.toLowerCase().includes(needle))
    .map((user) => user.id);
}
