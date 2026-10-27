import { readFileSync } from 'node:fs';
import { finish } from '../../lib/checks.mjs';
import { bars } from './make-chart.mjs';

const tallest = bars.reduce((best, bar) => (bar.height > best.height ? bar : best)).label;
let answer = '';
try {
  answer = readFileSync('answer.txt', 'utf8').trim();
} catch {
  finish(false, 'answer.txt is missing');
}
finish(
  answer.toUpperCase() === tallest,
  `answer.txt says ${JSON.stringify(answer.slice(0, 40))}; the tallest bar is ${tallest}`,
);
