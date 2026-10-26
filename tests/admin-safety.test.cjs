const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = process.env.ADMIN_SOURCE_ROOT || path.join(__dirname, '..');

function admin({ session = {}, local = {}, fetch } = {}) {
  const nodes = new Map(), events = new Map(), timers = [];
  const element = () => ({ value: '', textContent: '', style: {}, dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [],
    setAttribute() {}, addEventListener() {}, querySelector: () => null });
  const document = { body: element(), documentElement: element(),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener: (event, fn) => events.set(event, fn) };
  const storage = values => ({ getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); }, removeItem: key => { delete values[key]; } });
  const c = vm.createContext({ document, localStorage: storage(local), sessionStorage: storage(session),
    location: { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/admin.html' },
    URL, TextEncoder, TextDecoder, atob, btoa, console: { log() {} },
    fetch: fetch || (async () => { throw new Error('External network is disabled'); }),
    setTimeout: (fn, ms) => { if (ms <= 1200) queueMicrotask(fn); else timers.push({ fn, ms }); },
    clearTimeout() {}, setInterval() {}, clearInterval() {} });
  c.window = c;
  const run = code => vm.runInContext(code, c, { timeout: 1000 });
  for (const file of ['admin-app1.js', 'admin-app2.js']) run(fs.readFileSync(path.join(root, file), 'utf8'));
  run('var opened = false; showApp = () => { opened = true; }; renderTable = () => {}; setNoticeForm = () => {};');
  return { c, run, session, local, timers, node: id => document.getElementById(id), ready: () => events.get('DOMContentLoaded')?.() };
}
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('empty, rejected, unavailable and unauthorized credentials never open the app', async () => {
  for (const mode of ['empty', '401', 'repo403', 'readonly', 'offline']) {
    let requests = 0;
    const h = admin({ fetch: async () => {
      requests++;
      if (mode === 'offline') throw Error('offline');
      if (mode === '401') return response(401);
      if (requests === 1) return response(200);
      return mode === 'repo403' ? response(403) : response(200, { permissions: { push: false } });
    } });
    h.node('inp-token').value = mode === 'empty' ? '' : 'fixture-token';
    await h.run('doLogin()');
    assert.equal(h.run('opened'), false, mode);
    assert.equal(h.run('TOKEN'), '', mode);
    assert.equal(h.session['fv-adm'], undefined, mode);
    assert.equal(h.node('btn-login').disabled, false, mode);
    if (mode === 'empty') assert.equal(requests, 0);
  }
});

test('verified repository access stores the token only after both checks', async () => {
  let requests = 0;
  const h = admin({ fetch: async () => {
    assert.equal(h.session['fv-adm'], undefined);
    requests++;
    return response(200, { permissions: { push: true } });
  } });
  h.node('inp-token').value = ' fixture-token ';
  await h.run('doLogin()');
  assert.equal(requests, 2);
  assert.equal(h.run('opened'), true);
  assert.equal(h.session['fv-adm'], 'fixture-token');
});

test('double submission performs one verification', async () => {
  let resolveFirst, requests = 0;
  const h = admin({ fetch: async () => ++requests === 1
    ? new Promise(resolve => { resolveFirst = resolve; })
    : response(200, { permissions: { push: true } }) });
  const first = h.run("doLogin('fixture-token')");
  await h.run("doLogin('another-fixture-token')");
  assert.equal(requests, 1);
  resolveFirst(response(200));
  await first;
  assert.equal(h.session['fv-adm'], 'fixture-token');
});

test('restored tokens are revalidated after all scripts load', async () => {
  for (const cachedIn of ['session', 'local']) {
    let requests = 0;
    const h = admin({ [cachedIn]: { 'fv-adm': 'expired-fixture-token' },
      fetch: async () => { requests++; return response(401); } });
    assert.equal(h.run('TOKEN'), '');
    h.ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.equal(h.run('opened'), false);
    assert.equal(h.node('btn-login').disabled, false);
  }
});

test('Worker-only restoration makes no authentication success claim', () => {
  const h = admin({ session: { 'fv-admin-key': 'fixture-key' } });
  h.ready();
  assert.equal(h.run('opened'), true);
  assert.match(h.node('toast').textContent, /서버 요청 시 확인/);
});

test('fresh config reads cannot fall back to a stale CDN copy', async () => {
  const urls = [];
  const h = admin({ fetch: async url => {
    urls.push(url);
    return url.includes('raw.githubusercontent') ? response(200, { stale: true }) : response(503);
  } });
  await assert.rejects(h.run('fetchLatestSiteConfig({fresh:true})'), /최신 설정/);
  assert.equal(urls.length, 2);
  assert.equal(urls.some(url => url.includes('raw.githubusercontent')), false);
});

test('fresh config rejects array-shaped data from Worker and GitHub', async () => {
  const h = admin({ fetch: async url => response(200, url.includes('/api/catalog/')
    ? { ok: true, data: [] } : []) });
  h.run("TOKEN='fixture-token'");
  await assert.rejects(h.run('fetchLatestSiteConfig({fresh:true})'), /최신 설정/);
});

test('current Worker and GitHub configuration remain readable', async () => {
  for (const useWorker of [true, false]) {
    const config = { deletedProductIds: [7], customSetting: 'keep' };
    const h = admin({ fetch: async url => url.includes('/api/catalog/')
      ? response(useWorker ? 200 : 503, { ok: true, data: config })
      : response(200, { content: btoa(JSON.stringify(config)) }) });
    const loaded = await h.run('fetchLatestSiteConfig({fresh:true})');
    assert.equal(loaded.customSetting, 'keep');
    assert.equal(JSON.stringify(loaded.deletedProductIds), '[7]');
  }
});

test('config read failures cause zero writes in both save paths', async () => {
  const h = admin();
  h.run("fetchLatestSiteConfig=async()=>{throw Error('read outage')}; var writes=0; fetch=async()=>{writes++; return {ok:true,json:async()=>({ok:true})}}; configDirty=true;");
  await h.run("saveSiteConfig('notice')");
  await assert.rejects(h.run('persistDeletedProductIds({add:[7]})'), /read outage/);
  assert.equal(h.run('writes'), 0);
  assert.equal(h.run('configDirty'), true);
  assert.equal(h.node('btn-save-config').disabled, false);
});

test('successful config updates preserve unrelated settings', async () => {
  const h = admin();
  h.run("WORKER_URL='http://localhost'; ADMIN_KEY='fixture-key'; fetchLatestSiteConfig=async()=>({deletedProductIds:[7],customSetting:'keep'}); var saved; fetch=async(u,o)=>{saved=JSON.parse(o.body).config; return {ok:true,json:async()=>({ok:true})}};");
  await h.run("saveSiteConfig('notice')");
  assert.equal(h.run('saved.customSetting'), 'keep');
  assert.equal(h.run('JSON.stringify(saved.deletedProductIds)'), '[7]');
});

test('failed saves never register unsaved changes in any transport', async () => {
  for (const mode of ['direct', 'worker', 'ops']) {
    const h = admin();
    h.run(`WORKER_URL=${JSON.stringify(mode === 'direct' ? '' : 'http://localhost')}; ADMIN_KEY='fixture-key';
      products=[{id:7,name:'original'}]; siteConfig={}; fetchLatestProducts=async()=>[{id:7,name:'original'}];
      workerSupportsOps=async()=>${mode === 'ops'};
      saveViaDirect=saveViaWorker=saveViaWorkerOps=async()=>{throw Object.assign(Error('denied'),{status:403})};`);
    await assert.rejects(h.run("persistProductsMutation(list=>list.map(p=>({...p,name:'unsaved'})),'fixture')"), /denied/);
    assert.equal(h.run('myRecentEdits.size'), 0, mode);
    assert.equal(h.run('products[0].name'), 'original', mode);
    assert.equal(h.run('isSaving'), false, mode);
  }
});

test('conflict retries preserve earlier confirmed edits without adding failed edits', async () => {
  const h = admin();
  h.run("WORKER_URL=''; siteConfig={}; fetchLatestProducts=async()=>[{id:7,name:'original'}]; var attempts=0; registerMyRecentEdits([],[{id:8,name:'confirmed'}]); saveViaDirect=async()=>{attempts++; throw Object.assign(Error('conflict'),{status:409})};");
  await assert.rejects(h.run("persistProductsMutation(list=>list.map(p=>({...p,name:'unsaved'})),'fixture')"), /conflict/);
  assert.equal(h.run('attempts'), 3);
  assert.equal(h.run('myRecentEdits.size'), 1);
  assert.equal(h.run('myRecentEdits.has(7)'), false);
  assert.equal(h.run('myRecentEdits.get(8).product.name'), 'confirmed');
});

test('confirmed saves still protect their cache and no-op saves add nothing', async () => {
  const h = admin();
  h.run("WORKER_URL='http://localhost'; ADMIN_KEY='fixture-key'; siteConfig={}; fetchLatestProducts=async()=>[{id:7,name:'original'}]; workerSupportsOps=async()=>true; saveViaWorkerOps=async()=>({ok:true});");
  await h.run("persistProductsMutation(list=>list,'fixture')");
  assert.equal(h.run('myRecentEdits.size'), 0);
  await h.run("persistProductsMutation(list=>list.map(p=>({...p,name:'confirmed'})),'fixture')");
  assert.equal(h.run('myRecentEdits.get(7).product.name'), 'confirmed');
});

test('elapsed time cannot announce deployment success', () => {
  const h = admin(), span = { textContent: '' };
  h.node('deploy-banner').querySelector = () => span;
  h.run("markDeployStarted({ok:true},'fixture')");
  for (const timer of h.timers.slice()) timer.fn();
  assert.match(span.textContent, /아직 확인되지 않았습니다/);
  assert.doesNotMatch(span.textContent, /배포 완료/);
  assert.equal(h.timers.some(timer => timer.ms === 90000), false);
});
