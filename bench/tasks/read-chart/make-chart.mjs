// Draws fixture/chart.png for the read-chart task. It holds the answer, so it lives outside the
// fixture. `node make-chart.mjs` rewrites the PNG; `--check` confirms the committed pixels match.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const bars = [
  { label: 'PLUM', height: 150 },
  { label: 'KIWI', height: 228 },
  { label: 'LIME', height: 262 },
  { label: 'FIG', height: 120 },
  { label: 'PEAR', height: 205 },
];

// 5x7 glyphs for the letters the labels use.
const font = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
};

const width = 640;
const height = 400;
const baseline = 330;
const left = 40;
const slot = 112;
const barWidth = 64;
const pixel = 4;
const colors = {
  background: [255, 255, 255],
  grid: [229, 231, 235],
  axis: [75, 85, 99],
  bar: [59, 130, 246],
  text: [31, 41, 55],
};

function rectangle(png, x, y, w, h, [r, g, b]) {
  for (let row = y; row < y + h; row++) {
    for (let column = x; column < x + w; column++) {
      const index = (row * png.width + column) * 4;
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = 255;
    }
  }
}

function label(png, text, centerX, top) {
  let x = Math.round(centerX - (text.length * 6 - 1) * pixel * 0.5);
  for (const letter of text) {
    font[letter].forEach((line, row) => {
      [...line].forEach((cell, column) => {
        if (cell === '#')
          rectangle(png, x + column * pixel, top + row * pixel, pixel, pixel, colors.text);
      });
    });
    x += 6 * pixel;
  }
}

export function drawChart() {
  const png = new PNG({ width, height });
  rectangle(png, 0, 0, width, height, colors.background);
  const span = slot * bars.length + 20;
  for (let y = baseline - 50; y > 40; y -= 50) rectangle(png, left - 10, y, span, 1, colors.grid);
  bars.forEach((bar, index) => {
    const center = left + slot * index + slot / 2;
    rectangle(png, center - barWidth / 2, baseline - bar.height, barWidth, bar.height, colors.bar);
    label(png, bar.label, center, baseline + 16);
  });
  rectangle(png, left - 10, baseline, span, 2, colors.axis);
  return png;
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const output = path.join(path.dirname(script), 'fixture', 'chart.png');
  const chart = drawChart();
  if (process.argv.includes('--check')) {
    const committed = PNG.sync.read(readFileSync(output));
    const same = committed.width === width && committed.data.equals(chart.data);
    console.log(
      same ? 'chart.png matches the generator' : 'chart.png is stale; rerun make-chart.mjs',
    );
    process.exit(same ? 0 : 1);
  }
  writeFileSync(output, PNG.sync.write(chart, { colorType: 2 }));
}
