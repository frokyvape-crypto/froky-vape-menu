const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
require(path.join(__dirname, '..', 'purchase-rules.js'));
const { payOrderText } = globalThis.PurchaseRules;
const fieldLength = text => text.chunks.join(' | ').length;

test('short orders keep the original wording', () => {
  const text = payOrderText(['저스코 입호흡 액상 30ml / 망고 5개'], 5);
  assert.equal(text.fits, true);
  assert.deepEqual(text.chunks, ['저스코 입호흡 액상 30ml / 망고 5개', '총 구매수량 5개']);
});

test('long orders drop filler words but keep every product and flavor', () => {
  const lines = Array.from({ length: 6 }, (_, i) => `상품${i} 입호흡 액상 30ml / 맛${i} 2개 / 맛${i + 10} 3개`);
  lines.push('일회용 전자담배 18ml / 라임 5개');
  assert.ok(lines.join(' | ').length > 200);
  const text = payOrderText(lines, 35);
  assert.equal(text.fits, true);
  assert.ok(fieldLength(text) <= 200);
  for (let i = 0; i < 6; i++) assert.ok(text.chunks[0].includes(`맛${i + 10} 3개`));
  assert.ok(text.chunks[0].includes('일회용 18ml/라임 5개'));
  assert.equal(text.chunks[1], '총 35개');
});

test('orders that cannot fit say how many products are missing and are never cut mid-line', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `상품 이름이 긴 ${i} 입호흡 액상 30ml / 맛 ${i} 5개`);
  const text = payOrderText(lines, 100);
  assert.equal(text.fits, false);
  assert.ok(fieldLength(text) <= 200);
  const parts = text.chunks[0].split(' | ');
  const missing = Number(parts.pop().match(/외 (\d+)종 카톡 전달/)[1]);
  assert.equal(parts.length + missing, 20);
  parts.forEach((part, i) => assert.equal(part, `상품 이름이 긴 ${i} 입호흡 30ml/맛 ${i} 5개`));
  assert.equal(text.chunks[1], '총 100개');
});

test('a single line longer than the field is replaced rather than cut', () => {
  const text = payOrderText(['가'.repeat(300)], 5);
  assert.equal(text.fits, false);
  assert.deepEqual(text.chunks, ['외 1종 카톡 전달', '총 5개']);
});

test('the 200 character boundary matches the payment field', () => {
  const total = ' | 총 구매수량 5개';
  assert.equal(payOrderText(['가'.repeat(200 - total.length)], 5).chunks[1], '총 구매수량 5개');
  assert.equal(payOrderText(['가'.repeat(201 - total.length)], 5).chunks[1], '총 5개');
});
