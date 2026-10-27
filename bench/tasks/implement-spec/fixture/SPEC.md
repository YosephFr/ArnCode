# expandRanges

`expandRanges(input)` turns a page selection, as typed in a print dialog, into the list of pages it
selects. Export it from `src/ranges.js`.

## Rules

1. `input` is a string of items separated by commas. An item is a page number (`7`) or a range of
   two page numbers joined by a hyphen (`3-5`).
2. A page number is one or more ASCII digits (`0` to `9`) whose value is at least 1. Leading zeros
   are allowed: `007` is page 7.
3. Spaces and tabs around an item and around the hyphen are ignored: `2 - 4 ,  7` selects pages
   2, 3, 4 and 7.
4. A range includes both ends and may run backwards: `5-3` selects pages 3, 4 and 5.
5. The result is an array of numbers in ascending order without duplicates: `3,1-3` returns
   `[1, 2, 3]`.
6. An empty input, or one made only of spaces and tabs, returns `[]`.
7. Any other input throws a `RangeError` whose message includes the first invalid item, trimmed.
   For example, `1,,2` (an empty item), `0`, `-2`, `1.5`, `2-`, `1-2-3` and `x7` are all invalid.
8. A selection of more than 10,000 pages throws a `RangeError`.
