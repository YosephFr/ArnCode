#!/usr/bin/env node
// Usage: tally [file...]
// Prints the word count of each file, then a total when there is more than one file.
// Without files, prints the word count of standard input.
import { readFileSync } from 'node:fs';
import { countWords } from '../lib/count.js';

const files = process.argv.slice(2);

if (files.length === 0) {
  console.log(String(countWords(readFileSync(0, 'utf8'))));
} else {
  let total = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      console.error(`tally: ${file}: cannot read file`);
      process.exit(1);
    }
    const count = countWords(text);
    total += count;
    console.log(`${count} ${file}`);
  }
  if (files.length > 1) console.log(`${total} total`);
}
