const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
require(path.join(__dirname, '..', 'purchase-rules.js'));
const { payOrderText, unitPrice, isUnavailable, orderLines, payText, payQuantity, payUrl, statusLines, validate } = globalThis.PurchaseRules;
const fieldLength = text => text.chunks.join(' | ').length;

test('short orders keep the original wording and show the total amount', () => {
  const text = payOrderText(['저스코 입호흡 액상 30ml / 망고 5개'], 5, 49500);
  assert.equal(text.fits, true);
  assert.deepEqual(text.chunks, ['저스코 입호흡 액상 30ml / 망고 5개', '총 구매수량 5개 · 합계 49,500원']);
});

test('long orders drop filler words but keep every product and flavor', () => {
  const lines = Array.from({ length: 6 }, (_, i) => `상품${i} 입호흡 액상 30ml / 맛${i} 2개 / 맛${i + 10} 3개`);
  lines.push('일회용 전자담배 18ml / 라임 5개');
  assert.ok(lines.join(' | ').length > 200);
  const text = payOrderText(lines, 35, 346500);
  assert.equal(text.fits, true);
  assert.ok(fieldLength(text) <= 200);
  for (let i = 0; i < 6; i++) assert.ok(text.chunks[0].includes(`맛${i + 10} 3개`));
  assert.ok(text.chunks[0].includes('일회용 18ml/라임 5개'));
  assert.equal(text.chunks[1], '총 35개 346,500원');
});

test('orders that cannot fit say how many products are missing and are never cut mid-line', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `상품 이름이 긴 ${i} 입호흡 액상 30ml / 맛 ${i} 5개`);
  const text = payOrderText(lines, 100, 990000);
  assert.equal(text.fits, false);
  assert.ok(fieldLength(text) <= 200);
  const parts = text.chunks[0].split(' | ');
  const missing = Number(parts.pop().match(/외 (\d+)종 카톡 전달/)[1]);
  assert.equal(parts.length + missing, 20);
  parts.forEach((part, i) => assert.equal(part, `상품 이름이 긴 ${i} 입호흡 30ml/맛 ${i} 5개`));
  assert.equal(text.chunks[1], '총 100개 990,000원');
});

test('a single line longer than the field is replaced rather than cut', () => {
  const text = payOrderText(['가'.repeat(300)], 5, 49500);
  assert.equal(text.fits, false);
  assert.deepEqual(text.chunks, ['외 1종 카톡 전달', '총 5개 49,500원']);
});

test('the 200 character boundary matches the payment field', () => {
  const total = ' | 총 구매수량 5개 · 합계 49,500원';
  assert.equal(payOrderText(['가'.repeat(200 - total.length)], 5, 49500).chunks[1], '총 구매수량 5개 · 합계 49,500원');
  assert.equal(payOrderText(['가'.repeat(201 - total.length)], 5, 49500).chunks[1], '총 5개 49,500원');
});

test('both stores use the same unit price rule', () => {
  const product = { price: 9900, optionPrices: { 고농도: 12000, 무료: 0, 음수: -100 } };
  assert.equal(unitPrice(product, '고농도'), 12000);
  assert.equal(unitPrice(product, '망고'), 9900);
  assert.equal(unitPrice(product, '무료'), 9900);
  assert.equal(unitPrice(product, '음수'), 9900);
  assert.equal(unitPrice(null, '망고'), 0);
});

test('deleted products, removed options and sold out items cannot be paid for', () => {
  const product = { options: ['망고', '라임'], soldOutOptions: ['라임'] };
  assert.equal(isUnavailable({ option: '망고' }, product), false);
  assert.equal(isUnavailable({ option: '망고' }, undefined), true, '삭제된 상품');
  assert.equal(isUnavailable({ option: '수박' }, product), true, '삭제된 옵션');
  assert.equal(isUnavailable({ option: '라임' }, product), true, '품절 옵션');
  assert.equal(isUnavailable({ option: '망고' }, { ...product, soldOut: true }), true, '품절 상품');
  assert.equal(isUnavailable({ option: '옵션 없음' }, { options: [] }), false, '옵션이 없는 상품');
});

test('order lines group flavors under one product', () => {
  const items = [
    { id: 1, name: '알케마스터2  입호흡', option: '망고', qty: 3 },
    { id: 2, name: '일회용', option: '옵션 없음', qty: 5 },
    { id: 1, name: '알케마스터2  입호흡', option: '멜론', qty: 2 },
  ];
  assert.deepEqual(orderLines(items), ['알케마스터2 입호흡 / 망고 3개 / 멜론 2개', '일회용 / 5개']);
});

test('the payment quantity is the total divided by 100 and refuses other amounts', () => {
  assert.equal(payQuantity(59400), 594);
  assert.equal(payQuantity(59450), 0);
  assert.equal(payQuantity(0), 0);
  assert.equal(payQuantity(-100), 0);
});

test('the payment address carries the quantity, amount and order text', () => {
  const product = { id: 1, name: '일반 상품', options: ['망고'] };
  const items = [{ id: 1, name: '일반 상품', option: '망고', qty: 6, price: 9900 }];
  const url = new URL(payUrl('https://example.com/pay/', items, [product]));
  assert.equal(url.searchParams.get('customOrder'), 'Y');
  assert.equal(url.searchParams.get('buyQty'), '594');
  assert.equal(url.searchParams.get('orderAmount'), '59400');
  assert.equal(url.searchParams.get('inputOption0'), '일반 상품 / 망고 6개');
  assert.equal(url.searchParams.get('inputOption1'), '총 구매수량 6개 · 합계 59,400원');
  assert.deepEqual(payText(items).chunks, [url.searchParams.get('inputOption0'), url.searchParams.get('inputOption1')]);
});

test('no payment address for an empty, rule-breaking or non-100-won order', () => {
  const product = { id: 1, name: '일반 상품', options: ['망고'] };
  const order = (qty, price) => [{ id: 1, name: '일반 상품', option: '망고', qty, price }];
  assert.equal(payUrl('https://example.com/', [], [product]), '');
  assert.equal(payUrl('https://example.com/', order(4, 9900), [product]), '');
  assert.equal(payUrl('https://example.com/', order(5, 8350), [product]), '');
});

test('status lines explain what is missing', () => {
  const product = { id: 1, name: '일반 상품', options: ['망고'] };
  const short = validate([{ id: 1, name: '일반 상품', option: '망고', qty: 3, price: 100 }], [product]);
  assert.deepEqual(statusLines(short), ['⚠️ 일반 상품 전체: 현재 3/5개 · 2개 더 담아주세요']);
  const enough = validate([{ id: 1, name: '일반 상품', option: '망고', qty: 5, price: 100 }], [product]);
  assert.deepEqual(statusLines(enough), ['✅ 일반 상품 전체: 합계 5개로 최소 주문 충족']);
});
