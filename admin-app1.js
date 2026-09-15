const REPO = 'frokyvape-crypto/froky-vape-menu';
const FILE = 'products.json';
const CONFIG_FILE = 'site-config.json';
const STOREFRONTS = {
  froky: { label: '프로키베이프', path: './' },
  vapedoit: { label: '베이프두잇', path: './vapedoit/' },
};
let activeStorefront = localStorage.getItem('fv-admin-storefront') || 'froky';
if (!STOREFRONTS[activeStorefront]) activeStorefront = 'froky';
const DEFAULT_SITE_CONFIG = {
  noticeMode: 'stock',
  noticeModes: [
    { label: '재고제품 고지 배너', value: 'stock' },
    { label: '기본 FROKY 화면', value: 'default' },
  ],
  noticeBannerImgs: ['images/notice-banner.svg'],
  noticeBannerImg: 'images/notice-banner.svg',
  noticePopupEnabled: true,
  noticePopupImgs: ['images/notice-popup.png'],
  noticePopupImg: 'images/notice-popup.png',
  categories: [
    { value: 'best', label: '🏆 베스트' },
    { value: '입호흡', label: '입호흡 액상' },
    { value: '폐호흡', label: '폐호흡 액상' },
    { value: '고농도', label: '고농도 액상' },
    { value: '일회용', label: '일회용 기기' },
  ],
  purchaseRules: {
    defaultUnit: 5,
    packPatterns: ['5병', '10병', '10개 단위', '10개입', '10개'],
    mixGroups: [],
  },
};
let TOKEN = '', fileSha = '', products = [];
let siteConfig = {...DEFAULT_SITE_CONFIG}, siteConfigSha = '';
let siteConfigLoaded = false;
let imgSlots = { main: [], detail: [] };
let noticeImgSlots = { banner: [], popup: [] };
let noticeModes = [...DEFAULT_SITE_CONFIG.noticeModes];
let categories = [...DEFAULT_SITE_CONFIG.categories];
let purchaseRulesDraft = null;
let editingMixGroupId = '';
let mixDraftProductIds = new Set();
let selectedNoticeMode = 'stock';
let isSaving = false;
let remoteHash = '';
let remoteConfigHash = '';
let lastSaveTime = 0;
let preSaveHash = ''; // 저장 직전 remoteHash — CDN 구버전 구별용
// 내가 방금 저장한 상품 변경분 보호용 (CDN/전파 지연으로 latest가 옛 버전을 줄 때 되돌아감 방지)
// id → { product, prev, deleted, savedAt }
let myRecentEdits = new Map();
const MY_EDIT_TTL_MS = 10 * 60 * 1000; // 10분 — CDN 5분 캐시 + 전파 지연을 충분히 덮는 보호 기간
// 우리가 직접 저장했거나 로드한 상품 상태 해시 기록. stale CDN(최대 5분 캐시)이
// 과거 상태를 반환해도 이 목록에 있으면 "외부 변경"으로 오인하지 않고 무시한다.
let knownProductHashes = [];
function recordKnownProductHash(hash) {
  if (!hash) return;
  const i = knownProductHashes.indexOf(hash);
  if (i !== -1) knownProductHashes.splice(i, 1);
  knownProductHashes.push(hash);
  if (knownProductHashes.length > 20) knownProductHashes.shift();
}
let autoRefreshTimer = null;
let pendingRemoteProducts = null;
let pendingRemoteConfig = null;
let configDirty = false;
const DEFAULT_WORKER_URL = 'https://froky-vape-admin.frokyvape.workers.dev';
let WORKER_URL = localStorage.getItem('fv-worker-url') || DEFAULT_WORKER_URL;
let ADMIN_KEY = sessionStorage.getItem('fv-admin-key') || localStorage.getItem('fv-admin-key') || '';

function catalogReadBase() {
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
    return `${location.origin}/api/catalog`;
  }
  return `${(WORKER_URL || DEFAULT_WORKER_URL).replace(/\/+$/, '')}/api/catalog`;
}

async function fetchCatalogSnapshot(type) {
  const r = await fetch(`${catalogReadBase()}/${type}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Worker 최신 조회 실패 (${r.status})`);
  const payload = await r.json();
  if (!payload?.ok || payload.data == null) throw new Error(payload?.message || 'Worker 최신 조회 응답 오류');
  return payload.data;
}

// ── localStorage DB ────────────────────────────
function dbSave() {
  localStorage.setItem('fv-products', JSON.stringify(products));
  if (fileSha) localStorage.setItem('fv-sha', fileSha);
  updateTopbar();
}
function dbLoad() {
  try {
    const raw = localStorage.getItem('fv-products');
    if (raw) products = JSON.parse(raw);
    fileSha = localStorage.getItem('fv-sha') || '';
  } catch(e) { products = []; }
}
function dbClear() {
  localStorage.removeItem('fv-products');
  localStorage.removeItem('fv-sha');
  products = []; fileSha = '';
}
function updateTopbar() {
  document.getElementById('topbar-user').textContent =
    products.length ? `상품 ${products.length}개 로드됨` : '상품 없음';
  const badge = document.getElementById('pending-badge');
  if (badge) badge.style.display = pendingRemoteProducts ? '' : 'none';
}

function renderStorefrontContext() {
  const store = STOREFRONTS[activeStorefront];
  document.documentElement.dataset.storefront = activeStorefront;
  document.querySelectorAll('.storefront-btn').forEach(btn => {
    const active = btn.dataset.storefront === activeStorefront;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  document.getElementById('topbar-logo').innerHTML =
    `${store.label} 관리자 <span style="font-size:.6rem;color:var(--muted);font-weight:400">v3.9</span>`;
  const openBtn = document.getElementById('storefront-open');
  openBtn.title = `${store.label} 사용자 페이지 열기`;
  document.title = `${store.label} 관리자 v3.9`;
}

function selectStorefront(id) {
  if (!STOREFRONTS[id] || id === activeStorefront) return;
  activeStorefront = id;
  localStorage.setItem('fv-admin-storefront', id);
  renderStorefrontContext();
  toast(`${STOREFRONTS[id].label} 관리로 전환했습니다. 상품 변경은 두 페이지에 함께 반영됩니다.`, 'info');
}

function openActiveStorefront() {
  window.open(new URL(STOREFRONTS[activeStorefront].path, location.href).href, '_blank', 'noopener');
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('fv-theme', isLight ? 'light' : 'dark');
  document.getElementById('theme-btn').textContent = isLight ? '☀️' : '🌙';
}

function showApp() {
  document.getElementById('page-login').style.display = 'none';
  document.getElementById('page-app').style.display = 'flex';
  updateTopbar();
  startAutoRefresh();
  refreshAdminData({ silent: true });
}
function doLogin() {
  const t = (document.getElementById('inp-token').value || '').trim();
  if (!t) { toast('토큰을 입력하세요', 'err'); return; }
  TOKEN = t;
  sessionStorage.setItem('fv-adm', t);
  dbLoad();
  showApp();
  toast('로그인 완료' + (products.length ? ` (캐시 ${products.length}개 복원)` : ''), 'ok');
}
function logout() {
  stopAutoRefresh();
  TOKEN = '';
  sessionStorage.removeItem('fv-adm');
  localStorage.removeItem('fv-adm');
  products = []; fileSha = '';
  document.getElementById('page-app').style.display = 'none';
  document.getElementById('page-login').style.display = 'flex';
  document.getElementById('inp-token').value = '';
}

(function init() {
  renderStorefrontContext();
  if (localStorage.getItem('fv-theme') === 'light') {
    document.body.classList.add('light');
    document.getElementById('theme-btn').textContent = '☀️';
  }
  const _lsToken = localStorage.getItem('fv-adm');
  const t = sessionStorage.getItem('fv-adm') || _lsToken;
  if (_lsToken && !sessionStorage.getItem('fv-adm')) { sessionStorage.setItem('fv-adm', _lsToken); localStorage.removeItem('fv-adm'); }
  if (t) { TOKEN = t; dbLoad(); showApp(); }
  else if (WORKER_URL && ADMIN_KEY) { dbLoad(); showApp(); }
})();

async function ensureSiteConfigLoaded() {
  if (!siteConfigLoaded) await loadSiteConfig();
  else renderCategoryControls();
}

async function showSection(id) {
  const leavingConfigEditor = !['sec-notice', 'sec-categories', 'sec-purchase-rules'].includes(id) && pendingRemoteConfig;
  if (leavingConfigEditor) applyRemoteConfig(pendingRemoteConfig);
  document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = 'block';
  if (id === 'sec-products') {
    await ensureSiteConfigLoaded();
    await loadProducts();
  }
  if (id === 'sec-notice' || id === 'sec-categories' || id === 'sec-purchase-rules') await loadSiteConfig();
  if (id === 'sec-purchase-rules' && !products.length) await loadProducts({silent: true});
  if (id === 'sec-cafe24') {
    const _cid = sessionStorage.getItem('fv-c24-id') || localStorage.getItem('fv-c24-id') || '';
    const _sec = sessionStorage.getItem('fv-c24-sec') || localStorage.getItem('fv-c24-sec') || '';
    // Refresh Token은 장기 비밀이므로 영구저장 금지 → 세션저장만. 과거 localStorage 값은 세션으로 옮기고 삭제(마이그레이션).
    let _rt = sessionStorage.getItem('fv-c24-rt') || '';
    const _legacyRt = localStorage.getItem('fv-c24-rt');
    if (!_rt && _legacyRt) { _rt = _legacyRt; sessionStorage.setItem('fv-c24-rt', _legacyRt); }
    if (_legacyRt) localStorage.removeItem('fv-c24-rt');
    const idEl = document.getElementById('c24-id');
    const secEl = document.getElementById('c24-secret');
    const rtEl  = document.getElementById('c24-rt');
    if (idEl  && !idEl.value  && _cid) idEl.value  = _cid;
    if (secEl && !secEl.value && _sec) secEl.value = _sec;
    if (rtEl  && !rtEl.value  && _rt)  rtEl.value  = _rt;
  }
}

async function ghApi(method, path, body) {
  const r = await fetch('https://api.github.com' + path, {
    method,
    headers: { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { toast('토큰 권한 오류', 'err'); throw new Error('401'); }
  return r;
}

async function uploadImg(file) {
  const base64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const path = `images/${Date.now()}_${Math.random().toString(36).slice(2,6)}.${ext}`;
  if (WORKER_URL && ADMIN_KEY) {
    const wr = await fetch(WORKER_URL + '/api/github/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ path, content: base64 }),
    });
    const wd = await wr.json();
    if (!wr.ok || !wd.ok) throw new Error(wd.message || `Worker upload ${wr.status}`);
    return wd.url;
  }
  const r = await ghApi('PUT', `/repos/${REPO}/contents/${path}`, {
    message: `upload: ${file.name}`, content: base64, branch: 'main',
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e.message); }
  return `https://raw.githubusercontent.com/${REPO}/main/${path}`;
}

// ── 이미지 호환 헬퍼 ──────────────────────────────
function getImgs(p) {
  if (Array.isArray(p.imgs) && p.imgs.length) return p.imgs;
  if (p.img) return [p.img];
  return [];
}
function getDetailImgs(p) {
  if (Array.isArray(p.detailImgs) && p.detailImgs.length) return p.detailImgs;
  if (p.detailImg) return [p.detailImg];
  return [];
}

let modalOriginalOptions = [];
let modalOptionsDirty = false;
function getModalOptions() {
  if (!modalOptionsDirty && modalOriginalOptions.length) return [...modalOriginalOptions];
  const raw = document.getElementById('f-opts')?.value || '';
  const seen = new Set();
  return raw.split(',').map(s => s.trim()).filter(Boolean).filter(opt => !seen.has(opt) && seen.add(opt));
}
function normalizeOptionPrices(map, allowedOptions) {
  const allowed = new Set(allowedOptions || []);
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  Object.entries(map).forEach(([option, value]) => {
    const key = String(option || '').trim();
    const price = parseInt(value, 10);
    if (key && (!allowed.size || allowed.has(key)) && price > 0) out[key] = price;
  });
  return out;
}
function collectOptionPricesFromRows() {
  const out = {};
  document.querySelectorAll('#option-price-list input[data-option]').forEach(input => {
    const option = input.dataset.option || '';
    const price = parseInt(input.value, 10);
    if (option && price > 0) out[option] = price;
  });
  return out;
}
function handleModalOptionsInput() {
  modalOptionsDirty = true;
  renderOptionPriceRows();
}
let modalSoldOutOptions = new Set();
function toggleModalOptionSoldOut(button) {
  const option = button.dataset.option || '';
  if (!option) return;
  if (modalSoldOutOptions.has(option)) modalSoldOutOptions.delete(option);
  else modalSoldOutOptions.add(option);
  renderOptionPriceRows();
}
function renderOptionPriceRows(seedMap) {
  const el = document.getElementById('option-price-list');
  if (!el) return;
  const options = getModalOptions();
  const current = normalizeOptionPrices(seedMap || collectOptionPricesFromRows(), options);
  modalSoldOutOptions = new Set(options.filter(opt => modalSoldOutOptions.has(opt)));
  if (!options.length) {
    el.innerHTML = '<div class="option-price-empty">옵션을 입력하면 옵션별 가격 입력칸이 표시됩니다.</div>';
    return;
  }
  el.innerHTML = options.map(opt => {
    const value = current[opt] || '';
    const soldOut = modalSoldOutOptions.has(opt);
    return `<div class="option-price-row">
      <div class="option-price-name">${escHtml(opt)}</div>
      <input type="number" min="0" step="100" data-option="${escHtml(opt)}" value="${value}" placeholder="기본가 사용">
      <button type="button" class="btn btn-outline btn-xs option-stock-btn${soldOut ? ' is-soldout' : ''}" data-option="${escHtml(opt)}" onclick="toggleModalOptionSoldOut(this)">${soldOut ? '품절' : '판매중'}</button>
    </div>`;
  }).join('');
}
function adminOptionsText(p) {
  const options = Array.isArray(p.options) ? p.options : [];
  const prices = normalizeOptionPrices(p.optionPrices, options);
  const soldOutOptions = new Set(Array.isArray(p.soldOutOptions) ? p.soldOutOptions : []);
  if (!options.length) return '-';
  return options.map(opt => {
    const label = prices[opt] ? `${escHtml(opt)} (${Number(prices[opt]).toLocaleString('ko-KR')}원)` : escHtml(opt);
    return soldOutOptions.has(opt) ? `${label}<span class="option-soldout-mark">[품절]</span>` : label;
  }).join(', ');
}

// ── 멀티 이미지 슬롯 ─────────────────────────────
function renderImgGrid(slot) {
  const el = document.getElementById(`img-grid-${slot}`);
  if (!el) return;
  el.innerHTML = imgSlots[slot].map((item, i) => `
    <div class="img-slot">
      <img src="${escHtml(item.preview || item.url || '')}" onerror="this.src=''">
      <span class="img-slot-num">${i + 1}</span>
      <button type="button" class="img-slot-del" onclick="removeImgSlot('${slot}',${i})">×</button>
    </div>`).join('');
}
function addImgUrl(slot) {
  const inp = document.getElementById(`f-${slot}-url`);
  const url = (inp.value || '').trim();
  if (!url) { toast('URL을 입력하세요', 'err'); return; }
  imgSlots[slot].push({ url, file: null, preview: url });
  inp.value = '';
  renderImgGrid(slot);
}
function addImgFiles(input, slot) {
  [...input.files].forEach(file => {
    const preview = URL.createObjectURL(file);
    imgSlots[slot].push({ url: '', file, preview });
  });
  input.value = '';
  renderImgGrid(slot);
}
function removeImgSlot(slot, idx) {
  imgSlots[slot].splice(idx, 1);
  renderImgGrid(slot);
}

// ── 공지 이미지 슬롯 ──────────────────────────────
function renderNoticeImgGrid(slot) {
  const el = document.getElementById(`img-grid-notice-${slot}`);
  if (!el) return;
  el.innerHTML = noticeImgSlots[slot].map((item, i) => `
    <div class="img-slot">
      <img src="${escHtml(item.preview || item.url || '')}" onerror="this.src=''">
      <span class="img-slot-num">${i + 1}</span>
      <button type="button" class="img-slot-del" onclick="removeNoticeImg('${slot}',${i})">×</button>
    </div>`).join('');
}
function addNoticeImg(slot) {
  const inp = document.getElementById(`f-notice-${slot}-url`);
  const url = (inp.value || '').trim();
  if (!url) { toast('URL을 입력하세요', 'err'); return; }
  noticeImgSlots[slot].push({ url, file: null, preview: url });
  inp.value = '';
  renderNoticeImgGrid(slot);
  markConfigDirty();
}
function addNoticeImgFiles(input, slot) {
  [...input.files].forEach(file => {
    const preview = URL.createObjectURL(file);
    noticeImgSlots[slot].push({ url: '', file, preview });
  });
  input.value = '';
  renderNoticeImgGrid(slot);
  markConfigDirty();
}
function removeNoticeImg(slot, idx) {
  noticeImgSlots[slot].splice(idx, 1);
  renderNoticeImgGrid(slot);
  markConfigDirty();
}

// ── 내 직전 저장 변경분 보호 ──────────────────────────────────────
// 저장 직후 latest를 다시 받아올 때 CDN(~5분 캐시)/전파 지연으로 옛 버전이 오면,
// 내가 방금 저장한 상품이 옛 상태로 되돌아간다. 아래 헬퍼들이 "내가 최근에 저장한 변경"을
// 기억했다가, latest에 아직 반영 안 된 경우에만 다시 얹어 되돌아감을 막는다.
// (다른 관리자가 그 사이 같은 상품을 또 바꾼 경우는 존중하여 덮어쓰지 않는다.)
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

function pruneMyRecentEdits() {
  const now = Date.now();
  for (const [id, rec] of myRecentEdits) {
    if (now - rec.savedAt > MY_EDIT_TTL_MS) myRecentEdits.delete(id);
  }
}

// 저장 성공 직후 호출 — 이번에 추가/수정/삭제한 상품을 기록
function registerMyRecentEdits(before, after) {
  const now = Date.now();
  const beforeById = new Map(before.map(p => [p.id, p]));
  const afterById = new Map(after.map(p => [p.id, p]));
  for (const [id, prod] of afterById) {
    const prev = beforeById.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(prod)) {
      myRecentEdits.set(id, { product: clone(prod), prev: clone(prev) || null, deleted: false, savedAt: now });
    }
  }
  for (const [id, prev] of beforeById) {
    if (!afterById.has(id)) {
      myRecentEdits.set(id, { product: null, prev: clone(prev), deleted: true, savedAt: now });
    }
  }
}

// fetch한 latest 배열에 내 직전 변경이 빠져 있으면 복원해서 반환
function applyMyRecentEdits(list) {
  pruneMyRecentEdits();
  if (!myRecentEdits.size || !Array.isArray(list)) return list;
  const byId = new Map(list.map(p => [p.id, p]));
  for (const [id, rec] of myRecentEdits) {
    const cur = byId.get(id);
    if (rec.deleted) {
      if (cur && JSON.stringify(cur) === JSON.stringify(rec.prev)) {
        byId.delete(id);            // 내 삭제가 아직 반영 안 됨 → 제거
      } else if (!cur) {
        myRecentEdits.delete(id);   // 이미 반영됨 → 추적 종료
      }
      // cur가 prev와 다르면 다른 관리자가 되살리거나 수정한 것 → 존중
    } else {
      if (!cur) {
        byId.set(id, clone(rec.product));               // 내 추가가 아직 반영 안 됨 → 복원
      } else if (JSON.stringify(cur) === JSON.stringify(rec.product)) {
        myRecentEdits.delete(id);                        // 이미 반영됨 → 추적 종료
      } else if (rec.prev && JSON.stringify(cur) === JSON.stringify(rec.prev)) {
        byId.set(id, clone(rec.product));               // latest가 옛 버전 → 내 값으로 복원
      }
      // 그 외: 다른 관리자가 내 저장 이후 또 바꿈 → 존중
    }
  }
  return [...byId.values()];
}

async function fetchLatestProducts({ fresh = false, requireFresh = false } = {}) {
  // requireFresh: 인증/실시간 조회가 실패하면 stale CDN으로 폴백하지 않고 에러를 던진다
  // (직접 PAT 모드에서 옛 데이터 위에 저장해 다른 관리자 변경을 덮어쓰는 것을 차단)
  let apiAttempted = true;
  // 관리자끼리 같은 최신본을 보도록 Worker가 읽은 GitHub main을 최우선 사용한다.
  try {
    const data = await fetchCatalogSnapshot('products');
    if (Array.isArray(data)) return data;
  } catch (e) {}
  // TOKEN 있으면 raw 미디어 타입으로 직접 조회. fresh 모드(저장 직전)에는 비인증도 Contents API 사용 (CDN 5분 캐시 우회)
  if (TOKEN) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}?ref=main&t=${Date.now()}`, {
        headers: { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github.raw', 'Cache-Control': 'no-cache' },
        cache: 'no-store',
      });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data)) return data;
      }
    } catch (e) {}
  } else if (fresh) {
    apiAttempted = true;
    // Worker 전용 모드: 저장 직전에만 GitHub Contents API로 최신 데이터 조회 (공개 레포, rate-limit 60회/h 주의)
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}?ref=main&t=${Date.now()}`, {
        headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
        cache: 'no-store',
      });
      if (r.ok) {
        const meta = await r.json();
        if (meta && meta.content) {
          const data = JSON.parse(atob(meta.content.replace(/\n/g, '')));
          if (Array.isArray(data)) return data;
        }
      }
    } catch (e) {}
  }
  if (requireFresh && apiAttempted) {
    // 실시간 조회 실패 → 덮어쓰기 사고 방지를 위해 저장 중단
    throw Object.assign(
      new Error('최신 상품 데이터를 확인하지 못했습니다(캐시 폴백 차단). 잠시 후 다시 시도해 주세요.'),
      { staleBlocked: true }
    );
  }
  // 폴백: raw CDN. stale일 수 있으나 호출부에서 applyMyRecentEdits로 내 직전 변경을 복원한다.
  let r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) r = await fetch(`${FILE}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`products.json 조회 실패 (${r.status})`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('products.json 형식이 올바르지 않습니다');
  return data;
}

async function loadProducts({ silent = false } = {}) {
  if (!silent) document.getElementById('tbl-body').innerHTML = '<tr><td colspan="9" class="empty-msg"><span class="spin"></span>불러오는 중...</td></tr>';
  try {
    const latest = applyMyRecentEdits(await fetchLatestProducts({ fresh: true }));
    fileSha = '';
    const _delIds = new Set((siteConfig.deletedProductIds || []).map(Number));
    products = _delIds.size ? latest.filter(p => !_delIds.has(Number(p.id))) : latest;
    remoteHash = JSON.stringify(products);
    recordKnownProductHash(remoteHash);
    dbSave();
    renderTable();
    renderMixProductPicker();
    if (!silent) toast(`상품 ${products.length}개 로드`, 'ok');
  } catch (e) {
    if (!silent) toast('로드 실패: ' + e.message, 'err');
  }
}

function renderNoticeModes() {
  const el = document.getElementById('notice-modes-list');
  if (!el) return;
  if (!noticeModes.length) {
    el.innerHTML = '<div style="font-size:.75rem;color:var(--muted);padding:6px 0">모드가 없습니다. 아래에서 추가하세요.</div>';
    return;
  }
  el.innerHTML = noticeModes.map((m, i) => `
    <div class="notice-mode-item${m.value === selectedNoticeMode ? ' active' : ''}" onclick="selectNoticeMode('${m.value.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">
      <div class="nm-radio"></div>
      <span class="nm-label">${m.label}</span>
      <span class="nm-value">${m.value}</span>
      <button class="nm-del" type="button" onclick="event.stopPropagation();removeNoticeMode(${i})" title="삭제">✕</button>
    </div>`).join('');
}

function selectNoticeMode(value) {
  selectedNoticeMode = value;
  renderNoticeModes();
  markConfigDirty();
}

function addNoticeMode() {
  const labelEl = document.getElementById('f-notice-mode-label');
  const valueEl = document.getElementById('f-notice-mode-value');
  const label = labelEl.value.trim();
  const rawValue = valueEl.value.trim();
  if (!label) { toast('모드 이름을 입력하세요', 'err'); return; }
  const value = rawValue || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('mode-' + Date.now());
  if (noticeModes.some(m => m.value === value)) { toast('같은 값의 모드가 이미 있습니다', 'err'); return; }
  noticeModes.push({ label, value });
  labelEl.value = '';
  valueEl.value = '';
  renderNoticeModes();
  markConfigDirty();
}

function removeNoticeMode(idx) {
  const removed = noticeModes[idx];
  noticeModes.splice(idx, 1);
  if (selectedNoticeMode === removed.value) {
    selectedNoticeMode = noticeModes[0]?.value || '';
  }
  renderNoticeModes();
  markConfigDirty();
}

function normalizeCategories(list) {
  const src = Array.isArray(list) && list.length ? list : DEFAULT_SITE_CONFIG.categories;
  const seen = new Set();
  return src
    .map(c => typeof c === 'string' ? { value: c, label: c } : c)
    .map(c => ({ value: String(c.value || '').trim(), label: String(c.label || c.value || '').trim() }))
    .filter(c => c.value && c.label && !seen.has(c.value) && seen.add(c.value));
}

function categoryLabel(value) {
  return (categories.find(c => c.value === value)?.label) || value;
}

function renderCategoryControls() {
  categories = normalizeCategories(categories);
  const filter = document.getElementById('flt-cat');
  if (filter) {
    const current = filter.value;
    filter.innerHTML = '<option value="">전체</option>' + categories.map(c => `<option value="${escHtml(c.value)}">${escHtml(c.label)}</option>`).join('');
    filter.value = categories.some(c => c.value === current) ? current : '';
  }
  const select = document.getElementById('f-cat');
  if (select) {
    const current = select.value;
    select.innerHTML = categories.map(c => `<option value="${escHtml(c.value)}">${escHtml(c.label)}</option>`).join('');
    select.value = categories.some(c => c.value === current) ? current : categories[0]?.value || '';
  }
  const bulkCat = document.getElementById('bulk-cat');
  if (bulkCat) {
    const current = bulkCat.value;
    bulkCat.innerHTML = '<option value="">카테고리 변경 안함</option>' + categories.map(c => `<option value="${escHtml(c.value)}">${escHtml(c.label)}</option>`).join('');
    bulkCat.value = categories.some(c => c.value === current) ? current : '';
  }
  renderCategoryList();
  updateOrphanWarning();
}

function renderCategoryList() {
  const body = document.getElementById('cat-body');
  if (!body) return;
  body.innerHTML = categories.map((c, i) => `
    <tr>
      <td style="text-align:center">
        <button class="btn btn-outline btn-xs" onclick="moveCat(${i},-1)" ${i===0?'disabled':''} style="padding:3px 8px;font-size:.85rem">▲</button>
        <button class="btn btn-outline btn-xs" onclick="moveCat(${i},1)" ${i===categories.length-1?'disabled':''} style="padding:3px 8px;font-size:.85rem">▼</button>
      </td>
      <td><input class="field" value="${escHtml(c.label)}" onchange="updateCategory(${i}, 'label', this.value)"></td>
      <td><button class="btn btn-red btn-xs" onclick="removeCategory(${i})">삭제</button></td>
    </tr>`).join('');
}
function moveCat(idx, dir) {
  const to = idx + dir;
  if (to < 0 || to >= categories.length) return;
  [categories[idx], categories[to]] = [categories[to], categories[idx]];
  renderCategoryControls();
  markConfigDirty();
  toast('순서 변경됨 - 저장을 눌러 반영하세요', 'ok');
}

function addCategory() {
  const labelEl = document.getElementById('cat-label');
  const label = labelEl.value.trim();
  const value = label.replace(/\s+/g, '-');
  if (!label || !value) { toast('카테고리 이름을 입력하세요', 'err'); return; }
  if (categories.some(c => c.value === value)) { toast('이미 있는 카테고리입니다', 'err'); return; }
  categories.push({ label, value });
  labelEl.value = '';
  renderCategoryControls();
  markConfigDirty();
  toast('카테고리 추가됨 - 저장을 눌러 반영하세요', 'ok');
}

function updateCategory(idx, key, raw) {
  const value = String(raw || '').trim();
  if (!value) { renderCategoryControls(); return; }
  categories[idx][key] = key === 'value' ? value.replace(/\s+/g, '-') : value;
  categories = normalizeCategories(categories);
  renderCategoryControls();
  markConfigDirty();
}

function removeCategory(idx) {
  if (products.some(p => p.cat === categories[idx].value) && !confirm('이 카테고리를 사용하는 상품이 있습니다. 그래도 삭제할까요?')) return;
  categories.splice(idx, 1);
  renderCategoryControls();
  markConfigDirty();
}

function detectOrphanCategories() {
  const validValues = new Set(categories.map(c => c.value));
  const orphanMap = {};
  products.forEach(p => {
    if (!validValues.has(p.cat)) {
      orphanMap[p.cat] = (orphanMap[p.cat] || 0) + 1;
    }
  });
  return orphanMap;
}

function updateOrphanWarning() {
  const el = document.getElementById('orphan-warning');
  if (!el) return;
  const orphanMap = detectOrphanCategories();
  const entries = Object.entries(orphanMap);
  if (!entries.length) { el.style.display = 'none'; return; }
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const names = entries.map(([v, n]) => `"${v}" (${n}개)`).join(', ');
  document.getElementById('orphan-msg').textContent = `⚠️ 삭제된 카테고리를 사용하는 상품 ${total}개: ${names}`;
  const sel = document.getElementById('orphan-target');
  sel.innerHTML = categories.map(c => `<option value="${escHtml(c.value)}">${escHtml(c.label)}</option>`).join('');
  el.style.display = 'flex';
}

const DEFAULT_PURCHASE_RULES = {
  defaultUnit: 5,
  packPatterns: ['5병', '10병', '10개 단위', '10개입', '10개'],
  mixGroups: [],
};

function normalizePurchaseRules(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const patterns = Array.isArray(src.packPatterns) ? src.packPatterns : DEFAULT_PURCHASE_RULES.packPatterns;
  const seenPatterns = new Set();
  const packPatterns = patterns.map(value => String(value || '').trim())
    .filter(value => value && !seenPatterns.has(value) && seenPatterns.add(value));
  const groups = Array.isArray(src.mixGroups) ? src.mixGroups : [];
  const seenIds = new Set();
  const mixGroups = groups.map((group, index) => {
    let id = String(group?.id || `mix-${index + 1}`).trim();
    if (!id || seenIds.has(id)) id = `mix-${index + 1}-${Date.now()}`;
    seenIds.add(id);
    const keywords = Array.isArray(group?.keywords) ? group.keywords : [];
    const productIds = Array.isArray(group?.productIds) ? group.productIds : [];
    return {
      id,
      label: String(group?.label || id).trim(),
      keywords: [...new Set(keywords.map(value => String(value || '').trim()).filter(Boolean))],
      productIds: [...new Set(productIds.map(value => String(value || '').trim()).filter(Boolean))],
    };
  }).filter(group => group.label);
  return {
    defaultUnit: Math.max(1, parseInt(src.defaultUnit, 10) || DEFAULT_PURCHASE_RULES.defaultUnit),
    packPatterns: packPatterns.length ? packPatterns : [...DEFAULT_PURCHASE_RULES.packPatterns],
    mixGroups,
  };
}

function setPurchaseRulesForm() {
  purchaseRulesDraft = normalizePurchaseRules(siteConfig.purchaseRules);
  const unit = document.getElementById('rule-default-unit');
  const patterns = document.getElementById('rule-pack-patterns');
  if (unit) unit.value = purchaseRulesDraft.defaultUnit;
  if (patterns) patterns.value = purchaseRulesDraft.packPatterns.join(', ');
  startNewMixGroup({ silent: true });
  renderMixGroupList();
  renderMixProductPicker();
}

function renderMixGroupList() {
  const el = document.getElementById('mix-group-list');
  if (!el) return;
  const groups = purchaseRulesDraft?.mixGroups || [];
  if (!groups.length) {
    el.innerHTML = '<div class="option-price-empty">등록된 교차묶음 그룹이 없습니다. 아래에서 새 그룹을 만들어 주세요.</div>';
    return;
  }
  el.innerHTML = groups.map(group => {
    const keywordText = group.keywords.length ? `키워드: ${group.keywords.join(', ')}` : '키워드 없음';
    const productText = group.productIds.length ? `상품 ${group.productIds.length}개 직접 지정` : '직접 지정 상품 없음';
    return `<div class="mix-group-item">
      <div class="mix-group-main">
        <div class="mix-group-name">${escHtml(group.label)}</div>
        <div class="mix-group-meta">${escHtml(keywordText)} · ${escHtml(productText)}</div>
      </div>
      <div class="mix-group-actions">
        <button class="btn btn-outline btn-xs" type="button" onclick="editMixGroup('${escHtml(group.id)}')">수정</button>
        <button class="btn btn-red btn-xs" type="button" onclick="deleteMixGroup('${escHtml(group.id)}')">삭제</button>
      </div>
    </div>`;
  }).join('');
}

function updateMixSelectionCount() {
  const count = mixDraftProductIds.size;
  const el = document.getElementById('mix-selection-count');
  if (el) el.textContent = `선택 상품 ${count}개`;
}

function toggleMixProduct(input) {
  const id = String(input?.dataset?.mixProductId || '');
  if (!id) return;
  if (input.checked) mixDraftProductIds.add(id);
  else mixDraftProductIds.delete(id);
  updateMixSelectionCount();
  markConfigDirty();
}

function renderMixProductPicker() {
  const el = document.getElementById('mix-product-picker');
  if (!el) return;
  const q = String(document.getElementById('mix-product-search')?.value || '').trim().toLowerCase();
  const list = (products || []).filter(product => {
    if (!q) return true;
    return [product.name, product.flavor, product.id, product.product_no]
      .some(value => String(value || '').toLowerCase().includes(q));
  });
  if (!list.length) {
    el.innerHTML = '<div class="mix-product-empty">검색 결과가 없습니다.</div>';
    updateMixSelectionCount();
    return;
  }
  el.innerHTML = list.map(product => {
    const id = String(product.id);
    const checked = mixDraftProductIds.has(id) ? ' checked' : '';
    return `<label class="mix-product-option">
      <input type="checkbox" data-mix-product-id="${escHtml(id)}"${checked} onchange="toggleMixProduct(this)">
      <span>${escHtml(product.name || '(상품명 없음)')}</span>
      <small>#${escHtml(id)}</small>
    </label>`;
  }).join('');
  updateMixSelectionCount();
}

function startNewMixGroup({ silent = false } = {}) {
  editingMixGroupId = '';
  mixDraftProductIds = new Set();
  const id = document.getElementById('mix-edit-id');
  const label = document.getElementById('mix-label');
  const keywords = document.getElementById('mix-keywords');
  const search = document.getElementById('mix-product-search');
  if (id) id.value = '';
  if (label) label.value = '';
  if (keywords) keywords.value = '';
  if (search) search.value = '';
  const title = document.getElementById('mix-editor-title');
  if (title) title.textContent = '새 교차묶음 그룹';
  renderMixProductPicker();
  if (!silent) toast('새 교차묶음 그룹 입력을 시작합니다', 'info');
}

function editMixGroup(id) {
  const group = (purchaseRulesDraft?.mixGroups || []).find(item => item.id === id);
  if (!group) return;
  editingMixGroupId = group.id;
  mixDraftProductIds = new Set(group.productIds);
  document.getElementById('mix-edit-id').value = group.id;
  document.getElementById('mix-label').value = group.label;
  document.getElementById('mix-keywords').value = group.keywords.join(', ');
  document.getElementById('mix-product-search').value = '';
  document.getElementById('mix-editor-title').textContent = '교차묶음 그룹 수정';
  renderMixProductPicker();
  document.querySelector('.mix-group-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function deleteMixGroup(id) {
  const group = (purchaseRulesDraft?.mixGroups || []).find(item => item.id === id);
  if (!group || !confirm(`"${group.label}" 교차묶음 그룹을 삭제할까요?`)) return;
  purchaseRulesDraft.mixGroups = purchaseRulesDraft.mixGroups.filter(item => item.id !== id);
  if (editingMixGroupId === id) startNewMixGroup({ silent: true });
  renderMixGroupList();
  markConfigDirty();
  toast('교차묶음 그룹이 삭제되었습니다. 저장을 눌러 반영하세요.', 'info');
}

function saveMixGroupDraft() {
  const label = document.getElementById('mix-label')?.value.trim() || '';
  const rawKeywords = document.getElementById('mix-keywords')?.value || '';
  const keywords = [...new Set(rawKeywords.split(',').map(value => value.trim()).filter(Boolean))];
  if (!label) { toast('교차묶음 그룹 이름을 입력하세요', 'err'); return; }
  if (!keywords.length && !mixDraftProductIds.size) {
    toast('키워드 또는 포함 상품을 하나 이상 지정하세요', 'err');
    return;
  }
  const group = {
    id: editingMixGroupId || `mix-${Date.now()}`,
    label,
    keywords,
    productIds: [...mixDraftProductIds],
  };
  const index = purchaseRulesDraft.mixGroups.findIndex(item => item.id === group.id);
  if (index === -1) purchaseRulesDraft.mixGroups.push(group);
  else purchaseRulesDraft.mixGroups[index] = group;
  renderMixGroupList();
  markConfigDirty();
  startNewMixGroup({ silent: true });
  toast('교차묶음 그룹 목록에 반영했습니다. 마지막으로 저장하세요.', 'ok');
}

function collectPurchaseRulesFromForm() {
  const defaultUnit = Math.max(1, parseInt(document.getElementById('rule-default-unit')?.value, 10) || 1);
  const rawPatterns = document.getElementById('rule-pack-patterns')?.value || '';
  const packPatterns = [...new Set(rawPatterns.split(',').map(value => value.trim()).filter(Boolean))];
  return normalizePurchaseRules({
    defaultUnit,
    packPatterns,
    mixGroups: purchaseRulesDraft?.mixGroups || [],
  });
}

async function reclassifyOrphans() {
  const targetCat = document.getElementById('orphan-target').value;
  if (!targetCat) { toast('이동할 카테고리를 선택하세요', 'err'); return; }
  const orphanMap = detectOrphanCategories();
  const orphanValues = new Set(Object.keys(orphanMap));
  if (!orphanValues.size) { toast('고아 상품이 없습니다', 'info'); return; }
  const total = Object.values(orphanMap).reduce((s, n) => s + n, 0);
  if (!confirm(`${total}개 상품을 "${categoryLabel(targetCat)}" 카테고리로 이동할까요?`)) return;
  try {
    await persistProductsMutation(latest => latest.map(p =>
      orphanValues.has(p.cat) ? { ...p, cat: targetCat } : p
    ), `고아 상품 ${total}개 → ${categoryLabel(targetCat)} 재분류`);
    updateOrphanWarning();
    toast(`${total}개 상품 재분류 완료`, 'ok');
  } catch (e) {
    toast('재분류 실패: ' + e.message, 'err');
  }
}

function markConfigDirty() {
  configDirty = true;
}

function applyRemoteConfig(nextConfig) {
  siteConfig = {...DEFAULT_SITE_CONFIG, ...(nextConfig || {})};
  siteConfigLoaded = true;
  remoteConfigHash = JSON.stringify(siteConfig);
  pendingRemoteConfig = null;
  configDirty = false;
  setNoticeForm();
  renderTable();
}

function setNoticeForm() {
  noticeModes = Array.isArray(siteConfig.noticeModes) && siteConfig.noticeModes.length
    ? siteConfig.noticeModes
    : [...DEFAULT_SITE_CONFIG.noticeModes];
  categories = normalizeCategories(siteConfig.categories);
  renderCategoryControls();
  selectedNoticeMode = siteConfig.noticeMode || noticeModes[0]?.value || 'stock';
  renderNoticeModes();
  document.getElementById('notice-popup-enabled').checked = siteConfig.noticePopupEnabled !== false;
  const bannerImgs = Array.isArray(siteConfig.noticeBannerImgs) && siteConfig.noticeBannerImgs.length
    ? siteConfig.noticeBannerImgs
    : [siteConfig.noticeBannerImg || DEFAULT_SITE_CONFIG.noticeBannerImg];
  const popupImgs = Array.isArray(siteConfig.noticePopupImgs) && siteConfig.noticePopupImgs.length
    ? siteConfig.noticePopupImgs
    : [siteConfig.noticePopupImg || DEFAULT_SITE_CONFIG.noticePopupImg];
  noticeImgSlots.banner = bannerImgs.map(url => ({ url, file: null, preview: url }));
  noticeImgSlots.popup  = popupImgs.map(url  => ({ url, file: null, preview: url }));
  renderNoticeImgGrid('banner');
  renderNoticeImgGrid('popup');
  setPurchaseRulesForm();
}

async function fetchLatestSiteConfig({ fresh = false } = {}) {
  // 상품과 동일하게 Worker 최신본을 먼저 확인해 다른 관리자의 설정 변경을 빠르게 반영한다.
  try {
    const cfg = await fetchCatalogSnapshot('config');
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return {...DEFAULT_SITE_CONFIG, ...cfg};
  } catch (e) {}
  // TOKEN 있으면 raw 미디어 타입으로 직접 조회. fresh 모드(저장 직전)에는 비인증도 Contents API 사용
  if (TOKEN) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${CONFIG_FILE}?ref=main&t=${Date.now()}`, {
        headers: { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github.raw', 'Cache-Control': 'no-cache' },
        cache: 'no-store',
      });
      if (r.ok) {
        const cfg = await r.json();
        if (cfg && typeof cfg === 'object') return {...DEFAULT_SITE_CONFIG, ...cfg};
      }
    } catch (e) {}
  } else if (fresh) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${CONFIG_FILE}?ref=main&t=${Date.now()}`, {
        headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
        cache: 'no-store',
      });
      if (r.ok) {
        const meta = await r.json();
        if (meta && meta.content) {
          const cfg = JSON.parse(atob(meta.content.replace(/\n/g, '')));
          if (cfg && typeof cfg === 'object') return {...DEFAULT_SITE_CONFIG, ...cfg};
        }
      }
    } catch (e) {}
  }
  // 폴백: raw CDN
  let r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${CONFIG_FILE}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) r = await fetch(`${CONFIG_FILE}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`site-config.json 조회 실패 (${r.status})`);
  return {...DEFAULT_SITE_CONFIG, ...(await r.json())};
}

async function loadSiteConfig({ silent = false } = {}) {
  try {
    siteConfig = await fetchLatestSiteConfig();
    siteConfigSha = '';
    siteConfigLoaded = true;
    remoteConfigHash = JSON.stringify(siteConfig);
    configDirty = false;
    pendingRemoteConfig = null;
    setNoticeForm();
    if (!silent) toast('공지 설정 로드 완료', 'ok');
  } catch (e) {
    siteConfig = {...DEFAULT_SITE_CONFIG};
    siteConfigLoaded = true;
    setNoticeForm();
    if (!silent) toast('공지 설정 로드 실패: ' + e.message, 'err');
  }
}

async function saveSiteConfig(scope = 'notice') {
  const btn = document.getElementById('btn-save-config');
  const catBtn = document.getElementById('btn-save-categories');
  const rulesBtn = document.getElementById('btn-save-purchase-rules');
  btn.disabled = true;
  if (catBtn) catBtn.disabled = true;
  if (rulesBtn) rulesBtn.disabled = true;
  const activeBtn = scope === 'categories' ? catBtn : scope === 'purchaseRules' ? rulesBtn : btn;
  const originalLabel = activeBtn?.textContent || '저장';
  if (activeBtn) activeBtn.innerHTML = '<span class="spin"></span>저장 중...';
  try {
    let finalBannerImgs = null;
    let finalPopupImgs = null;
    if (scope === 'notice') {
      finalBannerImgs = [];
      for (const item of noticeImgSlots.banner) {
        if (item.file) { toast('배너 이미지 업로드 중...', 'info'); finalBannerImgs.push(await uploadImg(item.file)); }
        else if (item.url) finalBannerImgs.push(item.url);
      }
      finalPopupImgs = [];
      for (const item of noticeImgSlots.popup) {
        if (item.file) { toast('팝업 이미지 업로드 중...', 'info'); finalPopupImgs.push(await uploadImg(item.file)); }
        else if (item.url) finalPopupImgs.push(item.url);
      }
      if (!finalBannerImgs.length) finalBannerImgs.push(DEFAULT_SITE_CONFIG.noticeBannerImg);
      if (!finalPopupImgs.length) finalPopupImgs.push(DEFAULT_SITE_CONFIG.noticePopupImg);
    }

    let savedConfig = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const latestConfig = await fetchLatestSiteConfig({ fresh: true }).catch(() => ({...DEFAULT_SITE_CONFIG}));
      const nextConfig = scope === 'categories'
        ? {...latestConfig, categories: normalizeCategories(categories)}
        : scope === 'purchaseRules'
        ? {...latestConfig, purchaseRules: collectPurchaseRulesFromForm()}
        : {
            ...latestConfig,
            noticeMode: selectedNoticeMode || noticeModes[0]?.value || 'stock',
            noticeModes: noticeModes,
            noticeBannerImgs: finalBannerImgs,
            noticeBannerImg: finalBannerImgs[0],
            noticePopupEnabled: document.getElementById('notice-popup-enabled').checked,
            noticePopupImgs: finalPopupImgs,
            noticePopupImg: finalPopupImgs[0],
          };

      let status = 0;
      let contentSha = '';
      if (WORKER_URL && ADMIN_KEY) {
        const wr = await fetch(WORKER_URL + '/api/github/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ config: nextConfig }),
        });
        const wd = await wr.json();
        status = wd.status || wr.status;
        if (wr.ok && wd.ok) contentSha = wd.contentSha || '';
        else if (attempt === 0 && (status === 409 || status === 422)) continue;
        else throw Object.assign(new Error(wd.message || `Worker config ${wr.status}`), { status });
      } else {
        const latest = await ghApi('GET', `/repos/${REPO}/contents/${CONFIG_FILE}?ref=main`);
        let currentSha = '';
        if (latest.ok) currentSha = (await latest.json()).sha;
        else if (latest.status !== 404) throw new Error(`설정 SHA 조회 실패 (${latest.status})`);
        const body = {
          message: `chore: ${scope === 'categories' ? '카테고리' : scope === 'purchaseRules' ? '구매 규칙' : '공지 설정'} 업데이트 ${new Date().toLocaleString('ko-KR')}`,
          content: base64EncodeUtf8(JSON.stringify(nextConfig, null, 2) + '\n'),
          branch: 'main',
        };
        if (currentSha) body.sha = currentSha;
        const r = await ghApi('PUT', `/repos/${REPO}/contents/${CONFIG_FILE}`, body);
        status = r.status;
        if (!r.ok) {
          if (attempt === 0 && (status === 409 || status === 422)) continue;
          let e = {}; try { e = await r.json(); } catch {}
          throw Object.assign(new Error(e.message || `HTTP ${status}`), { status });
        }
        const saved = await r.json();
        contentSha = saved.content?.sha || '';
      }
      savedConfig = nextConfig;
      siteConfigSha = contentSha;
      break;
    }
    if (!savedConfig) throw new Error('다른 관리자의 저장과 충돌했습니다. 다시 시도해 주세요.');
    siteConfig = savedConfig;
    remoteConfigHash = JSON.stringify(savedConfig);
    configDirty = false;
    pendingRemoteConfig = null;
    setNoticeForm();
    if (scope === 'categories') updateOrphanWarning();
    toast(scope === 'categories' ? '카테고리 저장 완료' : scope === 'purchaseRules' ? '구매 규칙 저장 완료' : '공지 설정 저장 완료', 'ok');
  } catch (e) {
    toast((scope === 'categories' ? '카테고리' : scope === 'purchaseRules' ? '구매 규칙' : '공지 설정') + ' 저장 실패: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    if (catBtn) catBtn.disabled = false;
    if (rulesBtn) rulesBtn.disabled = false;
    if (activeBtn) activeBtn.textContent = originalLabel;
  }
}

function renderTable() {
  const q = (document.getElementById('flt-q').value || '').toLowerCase();
  const c = document.getElementById('flt-cat').value;
  const sort = document.getElementById('flt-sort')?.value || 'newest';
  const stock = document.getElementById('flt-stock')?.value || '';
  let list = products.filter(p =>
    (!q || p.name.toLowerCase().includes(q) || (p.flavor || '').toLowerCase().includes(q)) &&
    (!c || p.cat === c) &&
    (!stock || (stock === 'off' ? !!p.soldOut : !p.soldOut))
  );
  if (sort === 'newest') list = [...list].reverse();
  else if (sort === 'oldest') { /* 기본 순서 */ }
  else if (sort === 'name-asc') list.sort((a,b) => a.name.localeCompare(b.name, 'ko'));
  else if (sort === 'name-desc') list.sort((a,b) => b.name.localeCompare(a.name, 'ko'));
  else if (sort === 'price-asc') list.sort((a,b) => a.price - b.price);
  else if (sort === 'price-desc') list.sort((a,b) => b.price - a.price);
  document.getElementById('count-info').textContent = `총 ${list.length}개 표시 (전체 ${products.length}개)`;
  const fmt = n => Number(n).toLocaleString('ko-KR') + '원';
  const tb = document.getElementById('tbl-body');
  if (!list.length) { tb.innerHTML = '<tr><td colspan="9" class="empty-msg">상품이 없습니다</td></tr>'; return; }
  tb.innerHTML = list.map(p => `<tr>
    <td><input type="checkbox" class="prod-check" data-id="${p.id}" onchange="updateDeleteBtn()" style="width:14px;height:14px;accent-color:var(--g);cursor:pointer"></td>
    <td><img class="prod-img" src="${getImgs(p)[0] || ''}" onerror="this.src=''" alt=""></td>
    <td>
      <div style="font-weight:700;margin-bottom:2px">${escHtml(p.name)}</div>
      <div style="font-size:.72rem;color:var(--muted)">${escHtml(p.flavor || '')}</div>
      ${getDetailImgs(p).length ? `<div style="font-size:.68rem;color:var(--g);margin-top:2px">🖼 상세이미지 ${getDetailImgs(p).length}장</div>` : ''}
      ${getImgs(p).length > 1 ? `<div style="font-size:.68rem;color:var(--muted);margin-top:1px">📷 ${getImgs(p).length}장</div>` : ''}
    </td>
    <td style="white-space:nowrap">${fmt(p.price)}</td>
    <td><span class="cat-tag c-${p.cat}">${categoryLabel(p.cat)}</span></td>
    <td style="font-size:.75rem;color:var(--muted)">${adminOptionsText(p)}</td>
    <td>${p.sale ? '<span class="sale-tag">SALE</span>' : ''}</td>
    <td><button class="btn btn-outline btn-xs stock-toggle${p.soldOut ? ' is-soldout' : ''}" onclick="toggleSoldOut(${p.id})" title="클릭하여 판매상태 변경">${p.soldOut ? '품절' : '판매중'}</button></td>
    <td><div class="td-btns">
      <button class="btn btn-outline btn-xs" onclick="openEditModal(${p.id})">수정</button>
      <button class="btn btn-outline btn-xs" onclick="openOptionStockModal(${p.id})">옵션 품절</button>
      <button class="btn ${p.soldOut ? 'btn-g' : 'btn-red'} btn-xs btn-stock-action" onclick="toggleSoldOut(${p.id})">${p.soldOut ? '판매 재개' : '품절 처리'}</button>
      <button class="btn btn-red btn-xs" onclick="delProduct(${p.id})">삭제</button>
    </div></td>
  </tr>`).join('');
  updateDeleteBtn();
}

async function toggleSoldOut(id) {
  const product = products.find(p => Number(p.id) === Number(id));
  if (!product) return;
  const nextSoldOut = !product.soldOut;
  if (!confirm(`"${product.name}" 상품을 ${nextSoldOut ? '품절' : '판매중'} 상태로 변경할까요?`)) return;
  try {
    await persistProductsMutation(latest => latest.map(p =>
      Number(p.id) === Number(id) ? { ...p, soldOut: nextSoldOut } : p
    ), `${product.name} ${nextSoldOut ? '품절' : '판매 재개'}`);
  } catch (e) {
    toast('판매상태 변경 실패: ' + e.message, 'err');
  }
}

async function checkRemoteChanges() {
  if (isSaving) return;
  const anyModalOpen = !!document.querySelector('.modal-bg.open');
  try {
    const rawData = applyMyRecentEdits(await fetchLatestProducts());
    const _cDelIds = new Set((siteConfig.deletedProductIds || []).map(Number));
    const data = _cDelIds.size ? rawData.filter(p => !_cDelIds.has(Number(p.id))) : rawData;
    const hash = JSON.stringify(data);
    if (!remoteHash) { remoteHash = hash; recordKnownProductHash(hash); }
    else if (hash !== remoteHash) {
      // Worker 장애 폴백에서 stale CDN이 우리가 이미 저장/로드했던 과거 상태를 반환하는 경우 무시.
      // knownProductHashes에 없는 상태만 "다른 관리자의 외부 변경"으로 간주한다.
      if (knownProductHashes.includes(hash)) return;
      remoteHash = hash;
      recordKnownProductHash(hash);
      if (anyModalOpen) {
        pendingRemoteProducts = data;
        updateTopbar();
        toast('다른 관리자가 상품을 변경했습니다. 편집창을 닫으면 반영됩니다.', 'info');
      } else {
        products = data;
        pendingRemoteProducts = null;
        dbSave();
        renderTable();
        toast('다른 관리자의 상품 변경사항이 반영되었습니다', 'ok');
      }
    }
  } catch(e) {}

  try {
    const nextConfig = await fetchLatestSiteConfig();
    const hash = JSON.stringify(nextConfig);
    if (!remoteConfigHash) {
      remoteConfigHash = hash;
    } else if (hash !== remoteConfigHash) {
      remoteConfigHash = hash;
      const editingConfig = configDirty && (
        document.getElementById('sec-categories').style.display !== 'none' ||
        document.getElementById('sec-notice').style.display !== 'none' ||
        document.getElementById('sec-purchase-rules').style.display !== 'none'
      );
      if (editingConfig) {
        pendingRemoteConfig = nextConfig;
        toast('다른 관리자가 설정을 변경했습니다. 저장 전 새로고침해 확인해 주세요.', 'info');
      } else {
        applyRemoteConfig(nextConfig);
        toast('다른 관리자의 설정 변경사항이 반영되었습니다', 'ok');
      }
    }
  } catch(e) {}
}
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(checkRemoteChanges, 5000);
}
function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}
async function refreshAdminData({ silent = false } = {}) {
  await Promise.all([
    loadProducts({ silent }),
    loadSiteConfig({ silent }),
  ]);
  renderTable();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkRemoteChanges();
});
