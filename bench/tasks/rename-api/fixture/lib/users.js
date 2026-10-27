const USERS = new Map([
  ['u1', { id: 'u1', name: 'Ada Lovelace', username: 'ada', plan: 'pro', active: true }],
  ['u2', { id: 'u2', name: 'Alan Turing', username: 'alan', plan: 'free', active: true }],
  ['u3', { id: 'u3', name: 'Grace Hopper', username: 'grace', plan: 'pro', active: false }],
]);

/** A copy of the user's record, or undefined when there is no such user. */
export function getUserData(id) {
  const user = USERS.get(id);
  return user ? { ...user } : undefined;
}

/** Every user ID, in creation order. */
export function userIds() {
  return [...USERS.keys()];
}
