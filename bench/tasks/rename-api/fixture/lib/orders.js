import { getUserData } from './users.js';

/** Orders keep the buyer's name and username as they were when the order was placed. */
export function orderFor(userId, items) {
  const buyer = getUserData(userId);
  if (!buyer) throw new Error(`No user ${userId}`);
  return { buyer: { name: buyer.name, username: buyer.username }, items, placedBy: buyer.id };
}
