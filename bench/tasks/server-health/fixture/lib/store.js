import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ITEMS = fileURLToPath(new URL('../data/items.json', import.meta.url));

/** Every item in stock. */
export async function listItems() {
  const items = JSON.parse(await readFile(ITEMS, 'utf8'));
  return items.filter((item) => item.quantity > 0);
}

/** Fails when the store cannot be read, so /health reports it. */
export async function checkStorage() {
  const items = await listItems();
  if (!Array.isArray(items)) throw new Error('Storage is not a list of items');
}
