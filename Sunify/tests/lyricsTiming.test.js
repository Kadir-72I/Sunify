const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLRCWithWordTiming } = require('../src/renderer/lyricsTiming');

test('enhanced LRC timestamps control each word instead of equal line splitting', () => {
  const [line] = parseLRCWithWordTiming('[00:01.00]<00:01.00>Hello <00:01.55>world\n[00:03.00]Next line', 8);
  assert.equal(line.hasWordTiming, true);
  assert.equal(line.words[0].word, 'Hello');
  assert.equal(line.words[0].startTime, 1);
  assert.equal(line.words[0].endTime, 1.55);
  assert.equal(line.words[1].startTime, 1.55);
  assert.equal(line.words[1].endTime, 3);
});

test('positive LRC offset and fractional timestamps are applied to line timings', () => {
  const [first, second] = parseLRCWithWordTiming('[offset:+500]\n[00:01.5]Bir iki\n[00:03.00]Üç', 10);
  assert.equal(first.time, 2);
  assert.equal(first.words[0].startTime, 2);
  assert.equal(first.endTime, 3.5);
  assert.equal(second.time, 3.5);
});

test('LRC global offset is also applied to embedded word stamps', () => {
  const [line] = parseLRCWithWordTiming('[offset:+250]\n[00:01.00]<00:01.00>Bir <00:01.50>iki\n[00:03.00]Üç', 8);
  assert.equal(line.time, 1.25);
  assert.equal(line.words[0].startTime, 1.25);
  assert.equal(line.words[1].startTime, 1.75);
});

test('short adjacent lines never let word timing spill into the next lyric', () => {
  const [first, second] = parseLRCWithWordTiming('[00:01.00]Bir\n[00:01.40]İki', 5);
  assert.ok(first.words.at(-1).endTime <= second.time);
  assert.equal(first.endTime, second.time);
});

test('duplicate timestamps do not create duplicate lyric rows', () => {
  const lines = parseLRCWithWordTiming('[00:01.00]Bir\n[00:01.00]Bir\n[00:02.00]İki', 5);
  assert.equal(lines.length, 2);
});
