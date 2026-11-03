const assert = require('node:assert/strict');
const { test } = require('node:test');
require('../catalog-search.js');
const { matches } = globalThis.CatalogSearch;

const named = name => ({ name, flavor: '', options: [] });

test('빈 검색어는 모든 상품과 일치한다', () => {
  assert.equal(matches(named('아무 상품'), '  '), true);
});

test('상품명, 맛, 옵션을 띄어쓰기와 대소문자 없이 찾는다', () => {
  assert.equal(matches(named('Blue Razz 30ml'), 'bluerazz'), true);
  assert.equal(matches({ name: 'A', flavor: '망고', options: [] }, '망고'), true);
  assert.equal(matches({ name: 'A', flavor: '', options: ['라임 아이스'] }, '라임아이스'), true);
  assert.equal(matches({ name: 'A', flavor: '', options: null }, '라임'), false);
});

test('표기가 달라도 같은 상품을 찾는다', () => {
  for (const query of ['샤인머스켓', '샤인머스캣', '샤인 머스킷']) {
    assert.equal(matches(named('샤인머스캣 아이스'), query), true, query);
    assert.equal(matches(named('샤인머스켓 아이스'), query), true, query);
  }
  assert.equal(matches(named('메론 소다'), '멜론'), true);
  assert.equal(matches(named('토바코'), '연초'), true);
});

test('같은 뜻의 단어로 찾는다', () => {
  assert.equal(matches(named('그레이프 아이스'), '포도'), true);
  assert.equal(matches(named('청포도'), '그레이프'), true);
  assert.equal(matches(named('애플 민트'), '사과'), true);
  assert.equal(matches(named('그레이프프룻'), '자몽'), true);
});

test('이름이 겹치는 다른 과일은 섞지 않는다', () => {
  assert.equal(matches(named('파인애플'), '사과'), false);
  assert.equal(matches(named('파인애플'), '애플'), false);
  assert.equal(matches(named('그린애플'), '파인애플'), false);
  assert.equal(matches(named('파인애플'), '파인'), true);
  assert.equal(matches(named('그레이프프룻'), '포도'), false);
  assert.equal(matches(named('청포도'), '자몽'), false);
});
