const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const env = { GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'main', PRODUCTS_PATH: 'products.json', GITHUB_TOKEN: 't', ADMIN_KEY: 'k' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = content => JSON.parse(Buffer.from(content, 'base64').toString());

function worker(fetch) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'index.js'), 'utf8')
    .replace('export default {', 'globalThis.__worker = {');
  const context = vm.createContext({ TextEncoder, TextDecoder, atob, btoa, URL, Request, Response, setTimeout, fetch });
  context.globalThis = context;
  vm.runInContext(source, context);
  return (route, body, method = 'PUT') => context.__worker.fetch(new Request(`https://worker${route}`, {
    method, headers: { 'X-Admin-Key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, {});
}

test('a product file over 1MB keeps every product when one is saved', async () => {
  const puts = [];
  const send = worker(async (url, options = {}) => {
    if (options.method === 'PUT') { puts.push(JSON.parse(options.body)); return json({ content: {}, commit: {} }); }
    if (options.headers.Accept.includes('raw')) return json([{ id: 1 }, { id: 2 }, { id: 3 }]);
    return json({ sha: 'abc', content: '', encoding: 'none' });
  });
  const res = await send('/api/github/products', { ops: [{ type: 'upsert', product: { id: 2, name: '수정' } }] });
  assert.equal(res.status, 200);
  assert.equal(puts[0].sha, 'abc');
  assert.deepEqual(decode(puts[0].content).map(p => p.id), [1, 2, 3]);
  assert.equal(decode(puts[0].content)[1].name, '수정');
});

test('saving stops when the product list cannot be read', async () => {
  let writes = 0;
  const send = worker(async (url, options = {}) => {
    if (options.method === 'PUT') writes++;
    return json({ message: 'Not Found' }, 404);
  });
  const res = await send('/api/github/products', { ops: [{ type: 'upsert', product: { id: 1 } }] });
  assert.equal(res.status, 502);
  assert.equal(writes, 0);
});

test('a whole product list is refused so old data cannot replace new data', async () => {
  let calls = 0;
  const send = worker(async () => { calls++; return json({}); });
  const res = await send('/api/github/products', { products: [{ id: 1 }] });
  assert.equal(res.status, 400);
  assert.equal(calls, 0);
});

test('the upload API only writes inside images', async () => {
  const written = [];
  const send = worker(async (url, options = {}) => {
    if (options.method === 'PUT') { written.push(String(url).split('/contents/')[1]); return json({ content: {} }); }
    return json({}, 404);
  });
  for (const bad of ['index.html', '.github/workflows/x.yml', 'images/../index.html', 'images/.hidden', 'images/a/b.png']) {
    assert.equal((await send('/api/github/upload', { path: bad, content: 'YWJj' })).status, 400, bad);
  }
  assert.equal((await send('/api/github/upload', { path: 'images/1781_ab12.webp', content: 'YWJj' })).status, 200);
  assert.deepEqual(written, ['images/1781_ab12.webp']);
});

test('config saves use the version the admin read', async () => {
  const puts = [];
  let lookups = 0;
  const send = worker(async (url, options = {}) => {
    if (options.method === 'PUT') { puts.push(JSON.parse(options.body)); return json({ message: 'conflict' }, 409); }
    lookups++;
    return json({ sha: 'newest' });
  });
  const res = await send('/api/github/config', { config: { a: 1 }, sha: 'what-i-read' });
  assert.equal(res.status, 409);
  assert.equal(puts[0].sha, 'what-i-read');
  assert.equal(lookups, 0);
});

test('a failed Cafe24 listing still returns the new refresh token', async () => {
  const send = worker(async url => String(url).includes('/oauth/token')
    ? json({ access_token: 'a', refresh_token: 'new' })
    : json({ error: { message: 'denied' } }, 403));
  const body = { client_id: 'c', client_secret: 's', refresh_token: 'old', mall_id: 'm' };
  const res = await send('/api/cafe24/products', body, 'POST');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).new_refresh_token, 'new');
});

test('a thrown Cafe24 error still returns the new refresh token', async () => {
  const send = worker(async url => {
    if (String(url).includes('/oauth/token')) return json({ access_token: 'a', refresh_token: 'new' });
    throw Error('network down');
  });
  const res = await send('/api/cafe24/products', { client_id: 'c', client_secret: 's', refresh_token: 'old', mall_id: 'm' }, 'POST');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).new_refresh_token, 'new');
});

test('products whose options could not be read are marked', async () => {
  const send = worker(async url => {
    const address = String(url);
    if (address.includes('/oauth/token')) return json({ access_token: 'a', refresh_token: 'new' });
    if (address.includes('/products?')) return json({ products: [{ product_no: 1 }, { product_no: 2 }] });
    if (address.includes('/products/1')) return json({ product: { options: [] } });
    throw Error('Too many subrequests');
  });
  const body = { client_id: 'c', client_secret: 's', refresh_token: 'old', mall_id: 'm', with_options: true };
  const { products } = await (await send('/api/cafe24/products', body, 'POST')).json();
  assert.equal(products[0]._optionError, undefined);
  assert.equal(products[1]._optionError, '옵션 조회 실패');
});
