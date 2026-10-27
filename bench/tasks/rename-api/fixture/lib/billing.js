import { getUserData } from './users.js';

const PRICES = { free: 0, pro: 1200 };

/** Monthly charge in cents for an active user's plan. */
export function monthlyCharge(userId) {
  const user = getUserData(userId);
  if (!user || !user.active) return 0;
  return PRICES[user.plan] ?? 0;
}
