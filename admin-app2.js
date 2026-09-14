function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function setSavingUI(saving) {
  isSaving = saving;
  document.querySelectorAll('[data-deploy]').forEach(el => {
    el.style.opacity = saving ? '.5' : '';
    el.style.pointerEvents = saving ? 'none' : '';
  });
}

function showErrorModal({ action, cause, fix, status, message }) {
  document.getElementById('err-body').innerHTML = `
    <div style="margin-bottom:8px"><b>작업:</b> ${escHtml(action || '-')}</div>
    <div style="margin-bottom:8px"><b>원인:</b> ${escHtml(cause || '-')}</div>
    <div style="margin-bottom:8px"><b>해결:</b> ${escHtml(fix || '-')}</div>
    <div style="margin-bottom:8px"><b>상태코드:</b> <code style="background:var(--card);padding:1px 6px;border-radius:4px">${escHtml(String(status || '-'))}</code></div>
    <div><b>상세메시지:</b><br><code style="display:block;background:var(--card);padding:8px;border-radius:6px;margin-top:4px;font-size:.78rem;word-break:break-all">${escHtml(message || '-')}</code></div>`;
  document.getElementById('err-modal').classList.add('open');
}
function closeErrModal() { document.getElementById('err-modal').classList.remove('open'); }
function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function openWorkerModal() {
  document.getElementById('w-url').value = WORKER_URL;
  document.getElementById('w-key').value = ADMIN_KEY;
  document.getElementById('worker-modal').classList.add('open');
}
function closeWorkerModal() { document.getElementById('worker-modal').classList.remove('open'); }
function saveWorker() {
  WORKER_URL = document.getElementById('w-url').value.trim().replace(/\/$/, '');
  ADMIN_KEY = document.getElementById('w-key').value.trim();
  localStorage.setItem('fv-worker-url', WORKER_URL);
  sessionStorage.setItem('fv-admin-key', ADMIN_KEY);
  localStorage.removeItem('fv-admin-key');
  closeWorkerModal();
  toast(WORKER_URL ? 'Worker 모드 활성 (URL+Key 저장됨)' : '직접 모드 (Worker 미설정)', 'ok');
}
function clearWorker() {
  WORKER_URL = ''; ADMIN_KEY = '';
  localStorage.removeItem('fv-worker-url');
  localStorage.removeItem('fv-admin-key');
  sessionStorage.removeItem('fv-admin-key');
  document.getElementById('w-url').value = '';
  document.getElementById('w-key').value = '';
  toast('Worker 설정 초기화', 'info');
}

async function saveViaWorker(nextProducts = products) {
  const url = WORKER_URL + '/api/github/products';
  console.log('[saveAndDeploy] Worker mode:', url);
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ products: nextProducts }),
  });
  let data;
  try { data = await r.json(); } catch { data = { message: 'Invalid JSON response' }; }
  if (!r.ok || !data.ok) {
    showErrorModal({
      action: 'GitHub 상품 데이터 저장 (Worker)',
      cause: data.message || `HTTP ${r.status}`,
      fix: data.guide || 'Worker URL/Admin Key/Worker 환경변수를 확인하세요.',
      status: data.status || r.status,
      message: data.message || 'Unknown',
    });
    throw Object.assign(new Error(data.message || `HTTP ${r.status}`), { status: data.status || r.status });
  }
  console.log('[saveAndDeploy] Worker OK', data);
  return data;
}

// before→after를 비교해 실제 변경분(ops)만 추출. stale한 부분은 ops에 포함되지 않으므로
// Worker가 최신 위에 병합할 때 다른 관리자의 변경을 덮어쓰지 않는다.
function diffProducts(before, after) {
  const beforeById = new Map(before.map(p => [p.id, p]));
  const afterById = new Map(after.map(p => [p.id, p]));
  const ops = [];
  for (const [id, p] of afterById) {
    const b = beforeById.get(id);
    if (!b || JSON.stringify(b) !== JSON.stringify(p)) ops.push({ type: 'upsert', product: p });
  }
  for (const [id] of beforeById) {
    if (!afterById.has(id)) ops.push({ type: 'delete', id });
  }
  return ops;
}

// ops(변경분)만 Worker로 전송 → Worker가 GitHub 최신본 위에 병합 후 저장. 병합된 전체 배열 반환
// Worker가 ops 병합 모드를 지원하는지 확인 (구버전 Worker와의 하위 호환). 한 번 true면 캐시.
let workerOpsSupported = false;
async function workerSupportsOps() {
  if (workerOpsSupported) return true;
  try {
    const r = await fetch(WORKER_URL + '/api/health', { cache: 'no-store' });
    const d = await r.json();
    workerOpsSupported = !!d.productsOpsMerge;
  } catch { workerOpsSupported = false; }
  return workerOpsSupported;
}

async function saveViaWorkerOps(ops) {
  const url = WORKER_URL + '/api/github/products';
  console.log('[saveAndDeploy] Worker ops merge:', url, ops.length + ' ops');
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ ops }),
  });
  let data;
  try { data = await r.json(); } catch { data = { message: 'Invalid JSON response' }; }
  if (!r.ok || !data.ok) {
    showErrorModal({
      action: 'GitHub 상품 데이터 저장 (Worker 병합)',
      cause: data.message || `HTTP ${r.status}`,
      fix: data.guide || 'Worker URL/Admin Key/Worker 환경변수를 확인하세요. Worker가 최신 코드로 배포됐는지도 확인하세요.',
      status: data.status || r.status,
      message: data.message || 'Unknown',
    });
    throw Object.assign(new Error(data.message || `HTTP ${r.status}`), { status: data.status || r.status });
  }
  console.log('[saveAndDeploy] Worker merge OK', data);
  return data;
}

async function saveViaDirect(nextProducts = products) {
  console.log('[saveAndDeploy] Direct mode');
  const check = await ghApi('GET', `/repos/${REPO}/contents/${FILE}?ref=main`);
  let currentSha = '';
  if (check.ok) {
    const cur = await check.json();
    currentSha = cur.sha;
    console.log('[saveAndDeploy] GET OK sha=', currentSha);
  } else if (check.status === 404) {
    console.log('[saveAndDeploy] products.json 없음 (신규)');
  } else {
    let msg = ''; try { msg = (await check.json()).message; } catch {}
    showErrorModal({
      action: 'GitHub 상품 데이터 저장 — 현재 파일 SHA 조회',
      cause: `GET /contents/${FILE} 응답 ${check.status}`,
      fix: check.status === 401 || check.status === 403
        ? 'GitHub PAT의 repo 스코프 또는 fine-grained Contents:write 권한을 확인하세요.'
        : 'owner/repo/path/branch 설정을 확인하세요.',
      status: check.status, message: msg || `HTTP ${check.status}`,
    });
    throw new Error(`SHA 조회 실패 (HTTP ${check.status})`);
  }

  const content = base64EncodeUtf8(JSON.stringify(nextProducts, null, 2));
  const body = {
    message: `chore: 상품 업데이트 (관리자) ${new Date().toLocaleString('ko-KR')}`,
    content, branch: 'main',
  };
  if (currentSha) body.sha = currentSha;
  console.log('[saveAndDeploy] PUT sha=', body.sha || '(없음 — 신규)');

  const r = await ghApi('PUT', `/repos/${REPO}/contents/${FILE}`, body);
  if (!r.ok) {
    let e = {}; try { e = await r.json(); } catch {}
    showErrorModal({
      action: 'GitHub 상품 데이터 저장 — PUT /contents',
      cause: r.status === 422 ? '기존 파일 업데이트에 필요한 sha 누락 또는 stale'
           : r.status === 409 ? '다른 커밋과 충돌'
           : r.status === 401 || r.status === 403 ? 'GitHub 토큰 권한 부족'
           : `HTTP ${r.status}`,
      fix: r.status === 422 ? '저장 전 GET /contents/{path}로 현재 파일 sha를 다시 조회하세요. (v3.4은 이미 적용됨)'
         : r.status === 409 ? '잠시 후 재시도. 다른 사람이 동시에 푸시 중일 수 있습니다.'
         : 'PAT의 repo 스코프 또는 fine-grained Contents:write 권한 확인.',
      status: r.status, message: e.message || 'Unknown',
    });
    throw Object.assign(new Error(`PUT ${r.status}: ${e.message || ''}`), { status: r.status });
  }
  const rj = await r.json();
  fileSha = rj.content.sha;
  return { ok: true, commitUrl: rj.commit?.html_url };
}

async function saveAndDeploy() {
  if (isSaving) { toast('이미 저장 중...', 'info'); return; }
  await refreshAdminData({ silent: true });
  toast('상품·카테고리 최신 상태 확인 완료 — 각 수정은 저장 즉시 배포됩니다', 'ok');
}

function markDeployStarted(res, message) {
  dbSave();
  remoteHash = JSON.stringify(products);
  const banner = document.getElementById('deploy-banner');
  const span = banner?.querySelector('span');
  if (span) span.textContent = 'GitHub에 저장 후 배포 중... (30~60초)';
  banner?.classList.add('show');
  setTimeout(() => {
    if (span) span.textContent = '✅ 배포 완료 — 메뉴 페이지에 반영되었습니다';
    setTimeout(() => banner?.classList.remove('show'), 4000);
  }, 90000);
  toast(message + (res?.commitUrl ? ' (커밋 생성됨)' : ''), 'ok');
}

async function persistProductsMutation(mutator, message) {
  if (isSaving) throw new Error('이미 저장 중입니다');
  setSavingUI(true);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // 충돌 감지 시 최신 데이터 재로드 후 재시도
        toast('⚠️ 저장 충돌 감지 — 최신 데이터로 자동 재시도 중...', 'info');
        await new Promise(r => setTimeout(r, 600 * attempt));
      }
      const useWorker = WORKER_URL && ADMIN_KEY;
      // fresh: true → 실시간 데이터 조회. 직접(PAT) 모드에서는 requireFresh로 옛 캐시 폴백을 차단해
      // stale한 base 위에 저장하는 것을 원천 봉쇄한다. (Worker 모드는 서버가 다시 최신을 읽어 병합하므로 불필요)
      const latest = await fetchLatestProducts({ fresh: true, requireFresh: !useWorker });
      const _delIds = new Set((siteConfig.deletedProductIds || []).map(Number));
      // latest가 CDN/전파 지연으로 옛 버전이면, 내가 방금 저장한 변경분을 복원해 되돌아감 방지
      const base = applyMyRecentEdits(latest.map(p => ({...p})));
      const filteredLatest = _delIds.size ? base.filter(p => !_delIds.has(Number(p.id))) : base;
      preSaveHash = JSON.stringify(filteredLatest);
      recordKnownProductHash(preSaveHash); // 저장 직전 상태도 "우리가 본 상태"로 기록 (CDN 지연 대비)
      const nextProducts = mutator(base.map(p => ({...p})));
      if (!Array.isArray(nextProducts)) throw new Error('상품 변경 결과가 올바르지 않습니다');
      try {
        // 이번 변경분 기록 → 표시 일관성(내 편집 보호)
        registerMyRecentEdits(base, nextProducts);
        let res, adopt;
        if (useWorker && await workerSupportsOps()) {
          // 변경분(ops)만 전송 → Worker가 GitHub 최신본 위에 병합. 동시 편집해도 서로 안 덮어쑸.
          const ops = diffProducts(base, nextProducts);
          if (!ops.length) {
            toast('변경 사항이 없습니다', 'info');
            products = _delIds.size ? base.filter(p => !_delIds.has(Number(p.id))) : base;
            renderTable();
            return { ok: true, noChange: true };
          }
          res = await saveViaWorkerOps(ops);
          // Worker가 돌려준 병합 결과(다른 관리자 변경 포함)를 권위본으로 채택
          adopt = Array.isArray(res.products) ? res.products : nextProducts;
        } else if (useWorker) {
          // 구버전 Worker(ops 미지원) — 기존 전체 배열 저장으로 폴백 (하위 호환)
          res = await saveViaWorker(nextProducts);
          adopt = nextProducts;
        } else {
          res = await saveViaDirect(nextProducts);
          adopt = nextProducts;
        }
        products = _delIds.size ? adopt.filter(p => !_delIds.has(Number(p.id))) : adopt;
        pendingRemoteProducts = null;
        remoteHash = JSON.stringify(products);
        recordKnownProductHash(remoteHash); // 방금 저장한 새 상태 기록
        markDeployStarted(res, message);
        renderTable();
        return res;
      } catch (e) {
        if (attempt < 2 && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
    }
    throw new Error('다른 관리자의 저장과 계속 충돌합니다. 페이지를 새로고침 후 다시 시도해 주세요.');
  } finally {
    setSavingUI(false);
  }
}

async function persistDeletedProductIds({ add = [], remove = [] } = {}) {
  const addSet = new Set(add.map(Number).filter(Number.isFinite));
  const removeSet = new Set(remove.map(Number).filter(Number.isFinite));
  if (!addSet.size && !removeSet.size) return;

  for (let attempt = 0; attempt < 2; attempt++) {
    const latestConfig = await fetchLatestSiteConfig({ fresh: true }).catch(() => ({...DEFAULT_SITE_CONFIG}));
    const deleted = new Set((latestConfig.deletedProductIds || []).map(Number).filter(Number.isFinite));
    addSet.forEach(id => deleted.add(id));
    removeSet.forEach(id => deleted.delete(id));
    const nextConfig = {...latestConfig, deletedProductIds: [...deleted].sort((a, b) => a - b)};

    let status = 0;
    if (WORKER_URL && ADMIN_KEY) {
      const wr = await fetch(WORKER_URL + '/api/github/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ config: nextConfig }),
      });
      const data = await wr.json();
      status = data.status || wr.status;
      if (!wr.ok || !data.ok) {
        if (attempt === 0 && (status === 409 || status === 422)) continue;
        throw Object.assign(new Error(data.message || `삭제 목록 저장 실패 (${wr.status})`), { status });
      }
    } else {
      const latest = await ghApi('GET', `/repos/${REPO}/contents/${CONFIG_FILE}?ref=main`);
      let currentSha = '';
      if (latest.ok) currentSha = (await latest.json()).sha;
      else if (latest.status !== 404) throw new Error(`설정 SHA 조회 실패 (${latest.status})`);
      const body = {
        message: `chore: 삭제 상품 목록 업데이트 ${new Date().toLocaleString('ko-KR')}`,
        content: base64EncodeUtf8(JSON.stringify(nextConfig, null, 2) + '\n'),
        branch: 'main',
      };
      if (currentSha) body.sha = currentSha;
      const r = await ghApi('PUT', `/repos/${REPO}/contents/${CONFIG_FILE}`, body);
      status = r.status;
      if (!r.ok) {
        if (attempt === 0 && (status === 409 || status === 422)) continue;
        let data = {}; try { data = await r.json(); } catch {}
        throw Object.assign(new Error(data.message || `삭제 목록 저장 실패 (${status})`), { status });
      }
    }

    siteConfig = nextConfig;
    remoteConfigHash = JSON.stringify(nextConfig);
    return;
  }
  throw new Error('다른 관리자의 설정 저장과 충돌했습니다. 다시 시도해 주세요.');
}

let editId = null;
function resetModal() {
  modalSoldOutOptions = new Set();
  modalOriginalOptions = [];
  modalOptionsDirty = false;
  imgSlots = { main: [], detail: [] };
  renderImgGrid('main'); renderImgGrid('detail');
  ['f-id','f-name','f-price','f-flavor','f-opts'].forEach(id => document.getElementById(id).value = '');
  renderOptionPriceRows({});
  renderCategoryControls();
  document.getElementById('f-cat').value = '입호흡';
  document.getElementById('f-cat').value = categories[0]?.value || document.getElementById('f-cat').value;
  document.getElementById('f-sale').checked = false;
  document.getElementById('f-sold-out').checked = false;
  document.getElementById('f-main-file').value = '';
  document.getElementById('f-detail-file').value = '';
  const mainUrl = document.getElementById('f-main-url');
  const detailUrl = document.getElementById('f-detail-url');
  if (mainUrl) mainUrl.value = '';
  if (detailUrl) detailUrl.value = '';
}
function openAddModal() {
  editId = null; resetModal();
  document.getElementById('modal-title').textContent = '상품 추가';
  document.getElementById('prod-modal').classList.add('open');
}
function openEditModal(id) {
  const p = products.find(x => x.id === id); if (!p) return;
  editId = id; resetModal();
  document.getElementById('modal-title').textContent = '상품 수정';
  document.getElementById('f-id').value = id;
  document.getElementById('f-name').value = p.name;
  document.getElementById('f-price').value = p.price;
  document.getElementById('f-flavor').value = p.flavor || '';
  document.getElementById('f-cat').value = p.cat;
  modalOriginalOptions = Array.isArray(p.options) ? [...p.options] : [];
  modalOptionsDirty = false;
  document.getElementById('f-opts').value = (p.options || []).join(', ');
  modalSoldOutOptions = new Set(Array.isArray(p.soldOutOptions) ? p.soldOutOptions : []);
  renderOptionPriceRows(p.optionPrices || {});
  document.getElementById('f-sale').checked = !!p.sale;
  document.getElementById('f-sold-out').checked = !!p.soldOut;
  imgSlots.main   = getImgs(p).map(url => ({ url, file: null, preview: url }));
  imgSlots.detail = getDetailImgs(p).map(url => ({ url, file: null, preview: url }));
  renderImgGrid('main'); renderImgGrid('detail');
  document.getElementById('prod-modal').classList.add('open');
}
function openOptionStockModal(id) {
  openEditModal(id);
  document.getElementById('modal-title').textContent = '옵션별 품절 관리';
  setTimeout(() => document.getElementById('option-price-list')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0);
}
function applyPendingRemoteProducts() {
  if (!pendingRemoteProducts) return;
  products = pendingRemoteProducts;
  pendingRemoteProducts = null;
  dbSave();
  renderTable();
}
function closeModal() {
  document.getElementById('prod-modal').classList.remove('open');
  applyPendingRemoteProducts();
}
document.getElementById('prod-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
document.getElementById('err-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeErrModal(); });
document.getElementById('worker-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeWorkerModal(); });

async function saveProduct() {
  const name = document.getElementById('f-name').value.trim();
  const price = parseInt(document.getElementById('f-price').value);
  const flavor = document.getElementById('f-flavor').value.trim();
  if (!name) { toast('상품명을 입력하세요', 'err'); return; }
  if (!price || isNaN(price)) { toast('가격을 입력하세요', 'err'); return; }
  const btn = document.getElementById('btn-save-prod');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>저장 중...';
  try {
    const finalImgs = [];
    for (const item of imgSlots.main) {
      if (item.file) { toast('상품 이미지 업로드 중...', 'info'); finalImgs.push(await uploadImg(item.file)); }
      else if (item.url) finalImgs.push(item.url);
    }
    const finalDetailImgs = [];
    for (const item of imgSlots.detail) {
      if (item.file) { toast('상세 이미지 업로드 중...', 'info'); finalDetailImgs.push(await uploadImg(item.file)); }
      else if (item.url) finalDetailImgs.push(item.url);
    }
    const existing = editId !== null ? products.find(p => p.id === editId) : null;
    const options = getModalOptions();
    const optionPrices = normalizeOptionPrices(collectOptionPricesFromRows(), options);
    const obj = {
      id: editId !== null ? editId : Date.now(),
      ...(existing?.product_no != null ? { product_no: existing.product_no } : {}),
      name, price,
      imgs: finalImgs,
      img: finalImgs[0] || '',
      detailImgs: finalDetailImgs,
      detailImg: finalDetailImgs[0] || '',
      cat: document.getElementById('f-cat').value,
      flavor,
      options,
      optionPrices,
      soldOutOptions: options.filter(option => modalSoldOutOptions.has(option)),
      sale: document.getElementById('f-sale').checked,
      soldOut: document.getElementById('f-sold-out').checked,
    };
    await persistProductsMutation(latest => {
      if (editId === null) {
        return latest.some(p => p.id === obj.id) ? latest : [...latest, obj];
      }
      return latest.map(p => p.id === editId ? {...p, ...obj} : p);
    }, editId !== null ? '상품 수정 저장 & 배포 시작!' : '상품 추가 저장 & 배포 시작!');
    closeModal();
  } catch (e) { toast('실패: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '저장'; }
}

async function delProduct(id) {
  if (!confirm('이 상품을 완전히 삭제하시겠습니까?')) return;
  try {
    await persistDeletedProductIds({ add: [id] });
    await persistProductsMutation(
      latest => latest.filter(p => String(p.id) !== String(id)),
      '상품 삭제'
    );
  } catch (e) { toast('저장 실패: ' + e.message, 'err'); }
}

const CAT = name => {
  if (/폐호흡|모드|RDA|RTA/.test(name)) return '폐호흡';
  if (/솔트|Salt|SALT|고농도/.test(name)) return '고농도';
  if (/일회용|디스포/.test(name)) return '일회용';
  return '입호흡';
};

const CAFE24_CALLBACK = 'https://frokyvape-crypto.github.io/froky-vape-menu/cafe24-callback.html';
const CAFE24_MALL_ID  = 'frokyvape';

function startCafe24Auth() {
  const cid = document.getElementById('c24-id').value.trim();
  if (!cid) { toast('Client ID를 먼저 입력하세요', 'err'); return; }
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem('c24-state', state);
  const scope = 'mall.read_product';
  const authUrl = `https://${CAFE24_MALL_ID}.cafe24api.com/api/v2/oauth/authorize`
    + `?response_type=code&client_id=${encodeURIComponent(cid)}`
    + `&state=${state}&redirect_uri=${encodeURIComponent(CAFE24_CALLBACK)}`
    + `&scope=${encodeURIComponent(scope)}`;

  // postMessage 수신 대기
  window._c24AuthHandler = async (e) => {
    if (e.data?.type !== 'cafe24-auth-code') return;
    window.removeEventListener('message', window._c24AuthHandler);
    document.getElementById('c24-code-row').style.display = 'none';
    document.getElementById('c24-code').value = e.data.code;
    await exchangeCafe24Code();
  };
  window.addEventListener('message', window._c24AuthHandler);

  const popup = window.open(authUrl, 'cafe24auth', 'width=540,height=680,scrollbars=yes');
  if (!popup) {
    // 팝업 차단 → 코드 수동 입력 안내
    document.getElementById('c24-code-row').style.display = 'block';
    toast('팝업이 차단됐습니다. 아래 링크로 인증 후 코드를 입력하세요', 'info');
    window.open(authUrl, '_blank');
  } else {
    document.getElementById('c24-code-row').style.display = 'block';
    toast('카페24 로그인 후 인증을 완료하세요', 'info');
  }
}

async function exchangeCafe24Code() {
  const cid  = document.getElementById('c24-id').value.trim();
  const sec  = document.getElementById('c24-secret').value.trim();
  const code = document.getElementById('c24-code').value.trim();
  if (!cid || !sec || !code) { toast('Client ID, Secret, 인증 코드를 모두 입력하세요', 'err'); return; }

  toast('토큰 발급 중...', 'info');
  try {
    let d;
    if (WORKER_URL && ADMIN_KEY) {
      const r = await fetch(WORKER_URL + '/api/cafe24/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ client_id: cid, client_secret: sec, code, redirect_uri: CAFE24_CALLBACK, mall_id: CAFE24_MALL_ID }),
      });
      d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.message || `오류 (${r.status})`);
    } else {
      const proxy = 'https://corsproxy.io/?url=';
      const r = await fetch(proxy + encodeURIComponent(`https://${CAFE24_MALL_ID}.cafe24api.com/api/v2/oauth/token`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(cid + ':' + sec) },
        body: 'grant_type=authorization_code&code=' + encodeURIComponent(code) + '&redirect_uri=' + encodeURIComponent(CAFE24_CALLBACK),
      });
      d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error_description || d.error || `오류 (${r.status})`);
    }

    // 발급된 토큰 저장 (Refresh Token은 세션저장만 — 탭 닫으면 삭제)
    localStorage.setItem('fv-c24-id',  cid);
    sessionStorage.setItem('fv-c24-sec', sec);
    localStorage.removeItem('fv-c24-sec');
    sessionStorage.setItem('fv-c24-rt', d.refresh_token);
    localStorage.removeItem('fv-c24-rt');
    document.getElementById('c24-rt').value   = d.refresh_token;
    document.getElementById('c24-code').value = '';
    document.getElementById('c24-code-row').style.display = 'none';
    toast('✅ Refresh Token 발급 완료! 이제 상품을 불러올 수 있습니다', 'ok');
  } catch (e) {
    toast('토큰 발급 실패: ' + e.message, 'err');
  }
}


async function fetchCafe24() {
  const cid = document.getElementById('c24-id').value.trim();
  const sec = document.getElementById('c24-secret').value.trim();
  const rt  = document.getElementById('c24-rt').value.trim();
  if (!cid || !sec || !rt) { toast('카페24 Client ID / Secret / Refresh Token을 모두 입력하세요', 'err'); return; }
  const searchName = document.getElementById('c24-search').value.trim();
  const withOptions = !!document.getElementById('c24-with-options')?.checked;
  // 입력값 저장 (Secret·Refresh Token은 세션저장만 — 탭 닫으면 삭제)
  localStorage.setItem('fv-c24-id', cid);
  sessionStorage.setItem('fv-c24-sec', sec);
  localStorage.removeItem('fv-c24-sec');
  sessionStorage.setItem('fv-c24-rt', rt);
  localStorage.removeItem('fv-c24-rt');

  const btn = document.getElementById('btn-c24-load');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>불러오는 중...';
  document.getElementById('c24-result').style.display = 'none';
  try {
    let items = [];

    if (WORKER_URL && ADMIN_KEY) {
      // Worker 경유 (권장): 토큰 교환·상품 조회를 서버사이드에서 처리 → CORS 프록시 불필요, Secret 외부 노출 없음
      const r = await fetch(WORKER_URL + '/api/cafe24/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({
          client_id: cid, client_secret: sec, refresh_token: rt, mall_id: CAFE24_MALL_ID,
          product_name: searchName || undefined,
          with_options: withOptions,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.message || `카페24 조회 실패 (${r.status})`);
      items = d.products || [];
      if (d.new_refresh_token && d.new_refresh_token !== rt) {
        sessionStorage.setItem('fv-c24-rt', d.new_refresh_token);
        localStorage.removeItem('fv-c24-rt');
        document.getElementById('c24-rt').value = d.new_refresh_token;
        toast('Refresh Token 자동 갱신됨', 'info');
      }
      // Worker가 옵션 raw를 첨부한 경우 클라이언트 파서(extractC24Options)로 옵션명 추출
      if (withOptions) {
        if (!items.some(p => p._optionsRaw !== undefined)) {
          toast('옵션명은 Worker 재배포 후 지원됩니다 (기본 상품 정보는 정상)', 'info');
        } else {
          let optionProducts = 0;
          items = items.map(p => {
            let opts = [];
            const raws = Array.isArray(p._optionsRaw) ? p._optionsRaw : (p._optionsRaw ? [p._optionsRaw] : []);
            for (const raw of raws) { opts = extractC24Options(raw); if (opts.length) break; }
            if (opts.length) optionProducts++;
            return { ...p, _options: opts };
          });
          toast(`옵션명 ${optionProducts}/${items.length}개 상품에서 확인`, optionProducts ? 'ok' : 'info');
        }
      }
    } else {
      // 폴백: 공개 CORS 프록시(corsproxy.io) — 현재 403 차단 상태. Worker(URL+Admin Key) 설정을 권장.
      const proxy = 'https://corsproxy.io/?url=';
      const tr = await fetch(proxy + encodeURIComponent('https://frokyvape.cafe24api.com/api/v2/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(cid + ':' + sec) },
        body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt),
      });
      if (!tr.ok) throw new Error('CORS 프록시 오류 ' + tr.status + ' — Worker(URL+Admin Key)를 설정하면 프록시 없이 동작합니다');
      const td = await tr.json();
      if (td.error) throw new Error(`[${td.error}] ${td.error_description || ''} — Refresh Token 만료`);
      if (!td.access_token) throw new Error('액세스 토큰 없음');
      if (td.refresh_token && td.refresh_token !== rt) {
        sessionStorage.setItem('fv-c24-rt', td.refresh_token);
        localStorage.removeItem('fv-c24-rt');
        document.getElementById('c24-rt').value = td.refresh_token;
        toast('Refresh Token 자동 갱신됨', 'info');
      }
      let offset = 0;
      const limit = 100;
      while (true) {
        let apiUrl = `https://frokyvape.cafe24api.com/api/v2/admin/products?limit=${limit}&offset=${offset}`;
        if (searchName) apiUrl += `&product_name=${encodeURIComponent(searchName)}`;
        const pr = await fetch(proxy + encodeURIComponent(apiUrl), {
          headers: { 'Authorization': 'Bearer ' + td.access_token, 'X-Cafe24-Api-Version': '2026-03-01' },
        });
        if (!pr.ok) throw new Error('카페24 상품 조회 실패: ' + pr.status);
        const batch = (await pr.json()).products || [];
        items.push(...batch);
        if (batch.length < limit) break;
        offset += limit;
        btn.innerHTML = `<span class="spin"></span>불러오는 중... (${items.length}개)`;
      }
      if (withOptions && items.length) {
        items = await enrichCafe24Options(items, td.access_token, proxy, btn);
      }
    }

    // 클라이언트 사이드 검색 필터 (검색어 안전망)
    if (searchName) {
      const q = searchName.toLowerCase();
      items = items.filter(p => (p.product_name || '').toLowerCase().includes(q));
    }

    if (!items.length) { toast(searchName ? `"${searchName}" 검색 결과 없음` : '불러온 상품 없음', 'info'); return; }
    window._c24 = items;
    window._c24SellingFilter = '';
    updateC24SellingButtons();
    const filterEl = document.getElementById('c24-filter');
    if (filterEl) filterEl.value = '';
    document.getElementById('c24-count').textContent = items.length + '개 상품' + (searchName ? ` ("${searchName}" 검색결과)` : '') + ' 불러옴';
    filterC24();
    document.getElementById('c24-result').style.display = 'block';
    toast(items.length + '개 상품 불러옴', 'ok');
  } catch (e) { toast('오류: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '카페24 상품 불러오기'; }
}

function c24SelAll(v) { document.querySelectorAll('.import-check').forEach(cb => cb.checked = v); }

function cleanC24OptionText(value) {
  const text = String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text === '-' || /^[A-Z0-9]{8,}$/.test(text)) return '';
  return text;
}
function addC24OptionText(value, out) {
  const text = cleanC24OptionText(value);
  if (!text) return;
  text.split(/\s*[,/]\s*|\s*\n\s*/).map(v => cleanC24OptionText(v)).filter(Boolean).forEach(v => {
    if (!out.includes(v)) out.push(v);
  });
}
function addC24OptionValue(value, out) {
  if (value == null) return;
  if (typeof value === 'string' || typeof value === 'number') {
    addC24OptionText(value, out);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(v => addC24OptionValue(v, out));
    return;
  }
  if (typeof value === 'object') {
    if ('option_value' in value) addC24OptionValue(value.option_value, out);
    else if ('option_text' in value) addC24OptionValue(value.option_text, out);
    else if ('value' in value) addC24OptionValue(value.value, out);
    else if ('text' in value) addC24OptionValue(value.text, out);
  }
}
function walkC24OptionNodes(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(v => walkC24OptionNodes(v, out)); return; }
  if (typeof node !== 'object') return;
  ['option_text','option_value','option_values','value','values','text'].forEach(key => {
    if (key in node) addC24OptionValue(node[key], out);
  });
  ['options','option','variants','variant'].forEach(key => {
    if (key in node) walkC24OptionNodes(node[key], out);
  });
}
function extractC24Options(data) {
  const out = [];
  walkC24OptionNodes(data, out);
  const optionRoot = data?.option || data?.options || data;
  const optionGroups = [
    optionRoot?.options,
    optionRoot?.option,
    data?.options,
    data?.option?.options,
  ];
  optionGroups.forEach(group => {
    if (Array.isArray(group)) {
      group.forEach(item => {
        if (item && typeof item === 'object') addC24OptionValue(item.option_value ?? item.option_values ?? item.values, out);
        else addC24OptionValue(item, out);
      });
    } else if (group && typeof group === 'object') {
      addC24OptionValue(group.option_value ?? group.option_values ?? group.values, out);
    }
  });
  const variants = data?.variants || data?.variant || [];
  (Array.isArray(variants) ? variants : [variants]).forEach(variant => {
    addC24OptionValue(variant?.options ?? variant?.option, out);
  });
  return out;
}
async function fetchCafe24OptionsUrl(apiUrl, accessToken, proxy) {
  const res = await fetch(proxy + encodeURIComponent(apiUrl), {
    headers: { 'Authorization': 'Bearer ' + accessToken, 'X-Cafe24-Api-Version': '2026-03-01' },
  });
  if (!res.ok) {
    let msg = '';
    try { msg = JSON.stringify(await res.json()); } catch {}
    const err = new Error(`${res.status}${msg ? ` ${msg}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return extractC24Options(await res.json());
}
function isC24OptionApiError(error) {
  if (!error) return false;
  const status = Number(error.status || String(error.message || '').match(/^\d{3}/)?.[0] || 0);
  return status === 401 || status === 403 || status === 429 || status >= 500;
}
async function fetchCafe24ProductOptions(productNo, accessToken, proxy) {
  const base = `https://frokyvape.cafe24api.com/api/v2/admin/products/${productNo}`;
  let apiError = null;
  for (const apiUrl of [
    `${base}?embed=options,variants`,
    `${base}/options`,
    `${base}/variants`,
  ]) {
    try {
      const options = await fetchCafe24OptionsUrl(apiUrl, accessToken, proxy);
      if (options.length) return { options, error: null };
    } catch (e) {
      if (isC24OptionApiError(e)) apiError = e;
    }
  }
  return { options: [], error: apiError?.message || null };
}
async function enrichCafe24Options(items, accessToken, proxy, btn) {
  const enriched = [];
  let optionProducts = 0, apiErrors = 0;
  for (let i = 0; i < items.length; i++) {
    const product = items[i];
    btn.innerHTML = `<span class="spin"></span>옵션명 확인 중... (${i + 1}/${items.length})`;
    const result = await fetchCafe24ProductOptions(product.product_no, accessToken, proxy);
    const options = result.options;
    if (options.length) optionProducts++;
    if (result.error) apiErrors++;
    enriched.push({ ...product, _options: options, _optionError: result.error });
  }
  toast(`옵션명 ${optionProducts}/${items.length}개 상품에서 확인${apiErrors ? `, API 오류 ${apiErrors}개` : ''}`, apiErrors ? 'err' : (optionProducts ? 'ok' : 'info'));
  return enriched;
}

function isC24Selling(p) {
  const raw = String(p.selling ?? p.selling_status ?? p.product_selling ?? '').toUpperCase();
  return raw === 'T' || raw === 'Y' || raw === 'TRUE' || raw === '1';
}
function c24SellingLabel(p) {
  return isC24Selling(p) ? '판매중' : '판매안함';
}
function setC24SellingFilter(value) {
  window._c24SellingFilter = value || '';
  updateC24SellingButtons();
  filterC24();
}
function updateC24SellingButtons() {
  const current = window._c24SellingFilter || '';
  document.querySelectorAll('[data-c24-selling]').forEach(btn => {
    const active = btn.dataset.c24Selling === current;
    btn.className = active ? 'btn btn-g btn-xs' : 'btn btn-outline btn-xs';
  });
}
function filterC24() {
  const q = (document.getElementById('c24-filter')?.value || '').toLowerCase().trim();
  if (!window._c24) return;
  const existingNos = new Set(products.map(p => p.product_no).filter(Boolean));
  const toImg = s => {
    if (!s) return '';
    if (s.startsWith('//')) return 'https:' + s;
    if (s.startsWith('/')) return 'https://frokyvape.cafe24.com' + s;
    return s;
  };
  const statusFilter = window._c24SellingFilter || '';
  let filtered = window._c24;
  if (statusFilter === 'selling') filtered = filtered.filter(isC24Selling);
  if (statusFilter === 'not-selling') filtered = filtered.filter(p => !isC24Selling(p));
  if (q) filtered = filtered.filter(p => (p.product_name || '').toLowerCase().includes(q));
  const sellingCount = window._c24.filter(isC24Selling).length;
  const notSellingCount = window._c24.length - sellingCount;
  document.getElementById('c24-count').textContent =
    `${filtered.length}/${window._c24.length}개 표시 · 판매중 ${sellingCount}개 · 판매안함 ${notSellingCount}개`;
  document.getElementById('c24-tbody').innerHTML = filtered.map(p => {
    const origIdx = window._c24.indexOf(p);
    const img = toImg(p.list_image || p.detail_image || '');
    const isDupe = existingNos.has(p.product_no);
    const selling = isC24Selling(p);
    const optionCount = Array.isArray(p._options) ? p._options.length : 0;
    const optionNames = optionCount
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;max-width:520px">${p._options.map(opt => `<span title="${String(opt).replace(/"/g,'&quot;')}" style="display:inline-block;background:rgba(46,204,64,.1);border:1px solid rgba(46,204,64,.25);color:var(--g);border-radius:999px;padding:2px 7px;font-size:.66rem;font-weight:800;line-height:1.45">${escHtml(opt)}</span>`).join('')}</div>`
      : '';
    const optionStatus = optionCount
      ? ` <span style="font-size:.65rem;color:var(--g);font-weight:800;margin-left:4px">옵션 ${optionCount}개</span>${optionNames}`
      : p._optionError
        ? ` <span title="${String(p._optionError).replace(/"/g,'&quot;')}" style="font-size:.65rem;color:var(--red);font-weight:800;margin-left:4px">옵션 확인 실패</span>`
        : '';
    return `<tr style="${isDupe ? 'opacity:.45' : ''}">
      <td><input type="checkbox" class="import-check" data-i="${origIdx}" ${isDupe ? '' : 'checked'}></td>
      <td><img src="${img}" style="width:32px;height:32px;object-fit:cover;border-radius:5px;" onerror="this.src=''"></td>
      <td>${escHtml(p.product_name)}${isDupe ? ' <span style="font-size:.65rem;background:var(--red);color:#fff;padding:1px 5px;border-radius:3px;margin-left:4px">중복</span>' : ''}${optionStatus}</td>
      <td style="white-space:nowrap">${Number(p.price).toLocaleString('ko-KR')}원</td>
      <td><span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:.68rem;font-weight:800;background:${selling ? 'rgba(46,204,64,.16)' : 'rgba(229,57,53,.14)'};color:${selling ? 'var(--g)' : 'var(--red)'}">${c24SellingLabel(p)}</span></td>
      <td><span class="cat-tag c-${CAT(p.product_name)}">${categoryLabel(CAT(p.product_name))}</span></td>
    </tr>`;
  }).join('');
}

function selectAllProds() {
  document.querySelectorAll('.prod-check').forEach(cb => cb.checked = true);
  const allChk = document.getElementById('chk-all');
  if (allChk) allChk.checked = true;
  updateDeleteBtn();
}
function deselectAllProds() {
  document.querySelectorAll('.prod-check').forEach(cb => cb.checked = false);
  const allChk = document.getElementById('chk-all');
  if (allChk) { allChk.checked = false; allChk.indeterminate = false; }
  updateDeleteBtn();
}
function toggleSelectAll(v) {
  document.querySelectorAll('.prod-check').forEach(cb => cb.checked = v);
  updateDeleteBtn();
}
function selectedProductIds() {
  return [...document.querySelectorAll('.prod-check:checked')].map(cb => +cb.dataset.id);
}
function updateDeleteBtn() {
  const count = selectedProductIds().length;
  const total = document.querySelectorAll('.prod-check').length;
  const btn = document.getElementById('btn-del-sel');
  if (btn) btn.style.display = count > 0 ? '' : 'none';
  const bulkBar = document.getElementById('bulk-bar');
  if (bulkBar) bulkBar.style.display = count > 0 ? 'flex' : 'none';
  const countEl = document.getElementById('selected-count');
  if (countEl) countEl.textContent = `선택 ${count}개`;
  const allChk = document.getElementById('chk-all');
  if (allChk) {
    allChk.checked = total > 0 && count === total;
    allChk.indeterminate = count > 0 && count < total;
  }
}
async function applyBulkEdit() {
  const selectedIds = selectedProductIds();
  if (!selectedIds.length) { toast('수정할 상품을 선택하세요', 'err'); return; }
  const nextCat = document.getElementById('bulk-cat').value;
  const nextSale = document.getElementById('bulk-sale').value;
  const nextStock = document.getElementById('bulk-stock').value;
  if (!nextCat && !nextSale && !nextStock) { toast('변경할 항목을 선택하세요', 'err'); return; }
  if (!confirm(`선택한 ${selectedIds.length}개 상품을 일괄 수정할까요?`)) return;
  try {
    await persistProductsMutation(latest => latest.map(p => {
      if (!selectedIds.includes(p.id)) return p;
      return {
        ...p,
        ...(nextCat ? { cat: nextCat } : {}),
        ...(nextSale ? { sale: nextSale === 'on' } : {}),
        ...(nextStock ? { soldOut: nextStock === 'off' } : {}),
      };
    }), `선택 상품 ${selectedIds.length}개 수정`);
    document.getElementById('bulk-cat').value = '';
    document.getElementById('bulk-sale').value = '';
    document.getElementById('bulk-stock').value = '';
  } catch (e) { toast('일괄 수정 실패: ' + e.message, 'err'); }
}
async function deleteSelected() {
  const selectedIds = selectedProductIds();
  if (!selectedIds.length) return;
  if (!confirm(`선택한 ${selectedIds.length}개 상품을 완전히 삭제하시겠습니까?`)) return;
  try {
    await persistDeletedProductIds({ add: selectedIds });
    await persistProductsMutation(
      latest => {
        const selectedKeys = new Set(selectedIds.map(String));
        return latest.filter(p => !selectedKeys.has(String(p.id)));
      },
      `선택 상품 ${selectedIds.length}개 삭제`
    );
    updateDeleteBtn();
  } catch (e) { toast('선택 삭제 실패: ' + e.message, 'err'); }
}

async function importSelected() {
  const sel = [...document.querySelectorAll('.import-check:checked')].map(cb => window._c24[+cb.dataset.i]);
  let added = 0, updated = 0;
  if (!sel.length) { toast('추가할 상품을 선택하세요', 'err'); return; }

  // 낙관적 업데이트: GitHub 저장 전에 로컬 products 즉시 반영
  const toUrl = s => {
    if (!s) return '';
    if (s.startsWith('//')) return 'https:' + s;
    if (s.startsWith('/')) return 'https://frokyvape.cafe24.com' + s;
    return s;
  };
  sel.forEach(p => {
    const mainImg = toUrl(p.list_image || p.detail_image || '');
    const detailImg = toUrl(p.detail_image || '');
    const extraImgs = Array.isArray(p.additional_images)
      ? p.additional_images.map(img => toUrl(typeof img === 'string' ? img : (img.big || img.medium || img.url || img.small || ''))).filter(Boolean)
      : [];
    const allDetailImgs = [detailImg, ...extraImgs].filter(Boolean);
    const importedOptions = Array.isArray(p._options) ? p._options : [];
    const existing = products.find(x => x.id === p.product_no || x.product_no === p.product_no);
    if (!existing) {
      products.push({
        id: p.product_no, product_no: p.product_no, name: p.product_name, price: parseInt(p.price) || 0,
        imgs: mainImg ? [mainImg] : [], img: mainImg,
        detailImgs: allDetailImgs, detailImg: allDetailImgs[0] || '',
        cat: CAT(p.product_name), flavor: (p.summary_description || '').trim(),
        options: importedOptions, optionPrices: {}, sale: !!p.price_content,
      });
    }
  });
  document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
  document.getElementById('sec-products').style.display = 'block';
  renderTable();
  toast(`상품 추가 중... (${sel.length}개)`, 'info');

  try {
    await persistDeletedProductIds({ remove: sel.map(p => p.product_no) });
    await persistProductsMutation(latest => {
      const next = latest.map(p => ({...p}));
      sel.forEach(p => {
        const importedOptions = Array.isArray(p._options) ? p._options : [];
        const toUrl = s => {
          if (!s) return '';
          if (s.startsWith('//')) return 'https:' + s;
          if (s.startsWith('/')) return 'https://frokyvape.cafe24.com' + s;
          return s;
        };
        const mainImg = toUrl(p.list_image || p.detail_image || '');
        const detailImg = toUrl(p.detail_image || '');
        const extraImgs = Array.isArray(p.additional_images)
          ? p.additional_images.map(img => toUrl(typeof img === 'string' ? img : (img.big || img.medium || img.url || img.small || ''))).filter(Boolean)
          : [];
        const allDetailImgs = [detailImg, ...extraImgs].filter(Boolean);
        const existing = next.find(x => x.id === p.product_no || x.product_no === p.product_no);
        if (existing) {
          if (importedOptions.length) {
            existing.options = importedOptions;
            existing.optionPrices = normalizeOptionPrices(existing.optionPrices, importedOptions);
            updated++;
          }
          return;
        }
        next.push({
          id: p.product_no, product_no: p.product_no, name: p.product_name, price: parseInt(p.price) || 0,
          imgs: mainImg ? [mainImg] : [],
          img: mainImg,
          detailImgs: allDetailImgs,
          detailImg: allDetailImgs[0] || '',
          cat: CAT(p.product_name), flavor: (p.summary_description || '').trim(),
          options: importedOptions, optionPrices: {}, sale: !!p.price_content,
        });
        added++;
      });
      return next;
    }, `카페24 상품 ${sel.length}개 반영`);
    document.getElementById('c24-result').style.display = 'none';
    // GitHub CDN 캐시 문제로 showSection 재로드 생략 — persistProductsMutation이 이미 저장+렌더링 완료
    document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
    document.getElementById('sec-products').style.display = 'block';
    startAutoRefresh();
    toast(`${added}개 추가됨${updated ? `, 기존 ${updated}개 옵션 갱신됨` : ''}`, added || updated ? 'ok' : 'info');
  } catch (e) {
    toast('카페24 상품 반영 실패: ' + e.message, 'err');
  }
}

let _tt;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove('show'), 2400);
}
