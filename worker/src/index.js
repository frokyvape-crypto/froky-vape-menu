// FROKY VAPE Admin — Cloudflare Worker
// PUT /api/github/products  → products.json 저장
// PUT /api/github/config    → site-config.json 저장
// PUT /api/github/upload    → 이미지 파일 업로드
// POST /api/cafe24/products → 카페24 상품 목록 조회
// POST /api/cafe24/token    → 카페24 OAuth 코드→토큰 교환
// GET /api/health
//
// Environment:
//   vars:    GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, PRODUCTS_PATH
//   secret:  GITHUB_TOKEN, ADMIN_KEY

const REQUIRED_VARS = ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH', 'PRODUCTS_PATH', 'GITHUB_TOKEN', 'ADMIN_KEY'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/api/github/products' && request.method === 'PUT') {
      const result = await handleSaveProducts(request, env);
      const status = result.ok ? 200 : (result.status || 500);
      return jsonResponse(result, status);
    }

    if (url.pathname === '/api/github/config' && request.method === 'PUT') {
      const result = await handleSaveConfig(request, env);
      const status = result.ok ? 200 : (result.status || 500);
      return jsonResponse(result, status);
    }

    if (url.pathname === '/api/github/upload' && request.method === 'PUT') {
      const result = await handleUploadFile(request, env);
      const status = result.ok ? 200 : (result.status || 500);
      return jsonResponse(result, status);
    }

    if (url.pathname === '/api/cafe24/products' && request.method === 'POST') {
      const result = await handleCafe24Products(request, env);
      const status = result.ok ? 200 : (result.status || 500);
      return jsonResponse(result, status);
    }

    if (url.pathname === '/api/cafe24/token' && request.method === 'POST') {
      const result = await handleCafe24Token(request, env);
      const status = result.ok ? 200 : (result.status || 500);
      return jsonResponse(result, status);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({
        ok: true,
        version: '2026-06-10-ops-merge-hardened',
        productsOpsMerge: true,
        hardened: true,
        cafe24ProductsEndpoint: '/api/v2/admin/products',
        cafe24ProductsScope: 'all',
        ts: Date.now(),
      });
    }

    return jsonResponse({ ok: false, message: 'Not Found' }, 404);
  },
};

// 관리자 페이지가 호스팅되는 출처만 허용 (다른 웹사이트의 브라우저 호출 차단).
// 커스텀 도메인을 쓰게 되면 여기에 추가하세요.
const ALLOWED_ORIGINS = ['https://frokyvape-crypto.github.io'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'PUT, POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64DecodeUtf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 타이밍 안전 문자열 비교 (키 길이/내용 추론을 어렵게)
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  // 길이가 달라도 동일한 연산량을 수행해 조기 반환에 의한 정보 누출을 줄인다
  const len = Math.max(ab.length, bb.length, 1);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

// ── 관리자 키 무차별 입력 방어 (in-memory, best-effort) ────────────
// Cloudflare Worker는 요청마다 상태가 초기화될 수 있어 완벽한 rate limit은 아니지만,
// 같은 isolate 안에서의 연속 무차별 시도에 마찰을 준다. (강력하게 하려면 Cloudflare
// Rate Limiting Rules 또는 KV/Durable Objects 필요)
const FAILED_AUTH = new Map(); // ip -> { count, resetAt }
const RL_WINDOW_MS = 5 * 60 * 1000; // 5분
const RL_MAX_FAILS = 15;

function authRateLimited(ip) {
  const rec = FAILED_AUTH.get(ip);
  return !!(rec && Date.now() < rec.resetAt && rec.count >= RL_MAX_FAILS);
}
function recordAuthFail(ip) {
  const now = Date.now();
  let rec = FAILED_AUTH.get(ip);
  if (!rec || now >= rec.resetAt) rec = { count: 0, resetAt: now + RL_WINDOW_MS };
  rec.count++;
  FAILED_AUTH.set(ip, rec);
  if (FAILED_AUTH.size > 5000) {
    for (const [k, v] of FAILED_AUTH) if (now >= v.resetAt) FAILED_AUTH.delete(k);
  }
}
function recordAuthSuccess(ip) { FAILED_AUTH.delete(ip); }

function checkAuth(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (authRateLimited(ip)) {
    return { ok: false, status: 429, message: '인증 시도가 너무 많습니다.', guide: '잠시 후(약 5분 뒤) 다시 시도하세요.' };
  }
  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || !timingSafeEqual(adminKey, env.ADMIN_KEY)) {
    recordAuthFail(ip);
    return { ok: false, status: 401, message: 'Unauthorized', guide: 'X-Admin-Key 헤더가 누락되었거나 일치하지 않습니다.' };
  }
  recordAuthSuccess(ip);
  return null;
}

function checkEnv(env) {
  for (const k of REQUIRED_VARS) {
    if (!env[k]) {
      return { ok: false, status: 500, message: `환경변수 ${k} 누락`, guide: 'wrangler.toml vars 또는 wrangler secret put 으로 설정하세요.' };
    }
  }
  return null;
}

async function handleSaveProducts(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;
  const envErr = checkEnv(env);
  if (envErr) return envErr;

  let body;
  try { body = await request.json(); } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body', guide: 'request body는 JSON 이어야 합니다.' };
  }

  // ── ops 병합 모드 (동시 편집 안전) ──────────────────────────────
  // 클라이언트가 "내가 바꾼 변경분(ops)"만 보내면, Worker가 GitHub에서 최신 products.json을
  // 직접 읽어(인증 → 항상 최신) 그 위에 병합 후 저장한다. 브라우저 캐시가 옛 버전이어도
  // stale한 부분은 애초에 전송되지 않으므로 다른 관리자의 변경을 덮어쓰지 않는다.
  if (Array.isArray(body.ops)) {
    try {
      return await saveProductsWithOps(env, body.ops);
    } catch (e) {
      return { ok: false, status: 502, message: e.message || String(e), guide: 'GitHub API 호출 중 예외 발생.' };
    }
  }

  // ── 레거시 전체 배열 저장 모드 (대량 일괄 교체용) ────────────────
  const products = body.products;
  if (!Array.isArray(products)) {
    return { ok: false, status: 400, message: 'products 배열 또는 ops 배열이 필요합니다.', guide: '{ "ops": [...] } 또는 { "products": [...] } 형태로 전송하세요.' };
  }

  try {
    return await saveGithubJson(env, env.PRODUCTS_PATH, products, 'chore: update products from admin');
  } catch (e) {
    return { ok: false, status: 502, message: e.message || String(e), guide: 'GitHub API 호출 중 예외 발생.' };
  }
}

// products.json을 GitHub에서 읽어 { data, sha } 반환 (인증 → 항상 최신/일관)
async function readGithubJsonWithSha(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}&t=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'froky-vape-menu-worker',
      'Cache-Control': 'no-cache',
    },
  });
  if (res.status === 404) return { data: null, sha: null };
  const meta = await res.json();
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${meta.message || ''}`);
  let data = null;
  if (meta && meta.content) {
    data = JSON.parse(base64DecodeUtf8(meta.content.replace(/\n/g, '')));
  }
  return { data, sha: meta.sha || null };
}

// 주어진 sha 기준으로 PUT. 충돌(409/422) 여부를 호출부가 판단할 수 있게 raw 결과 반환
async function putGithubJsonWithSha(env, path, jsonData, message, sha) {
  const content = base64EncodeUtf8(JSON.stringify(jsonData, null, 2));
  const body = { message, content, branch: env.GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'froky-vape-menu-worker',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 상품 배열에 ops(upsert/delete)를 순서 보존하며 적용
function applyProductOps(arr, ops) {
  const list = Array.isArray(arr) ? arr : [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const order = list.map((p) => p.id);
  for (const op of ops) {
    if (op && op.type === 'upsert' && op.product && op.product.id != null) {
      if (!byId.has(op.product.id)) order.push(op.product.id);
      byId.set(op.product.id, op.product);
    } else if (op && op.type === 'delete' && op.id != null) {
      byId.delete(op.id);
    }
  }
  const seen = new Set();
  const result = [];
  for (const id of order) {
    if (byId.has(id) && !seen.has(id)) { seen.add(id); result.push(byId.get(id)); }
  }
  return result;
}

// 최신 읽기 → 병합 → 저장. sha 충돌 시 재읽기 후 재시도 (동시 저장 직렬화)
async function saveProductsWithOps(env, ops) {
  if (!ops.length) {
    const { data } = await readGithubJsonWithSha(env, env.PRODUCTS_PATH);
    return { ok: true, products: Array.isArray(data) ? data : [], noChange: true, updatedPath: env.PRODUCTS_PATH };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, sha } = await readGithubJsonWithSha(env, env.PRODUCTS_PATH);
    const baseArr = Array.isArray(data) ? data : [];
    const merged = applyProductOps(baseArr, ops);
    const put = await putGithubJsonWithSha(env, env.PRODUCTS_PATH, merged, 'chore: update products from admin (merge)', sha);
    if (put.ok) {
      return {
        ok: true,
        products: merged,
        mergedCount: merged.length,
        commitUrl: put.data.commit?.html_url || null,
        contentSha: put.data.content?.sha || null,
        updatedPath: env.PRODUCTS_PATH,
      };
    }
    // 다른 관리자가 그 사이 커밋해 sha가 어긋남 → 최신을 다시 읽어 병합 재시도
    if (put.status === 409 || put.status === 422) { await sleep(150 * (attempt + 1)); continue; }
    return {
      ok: false,
      status: put.status,
      message: put.data.message || '상품 병합 저장 실패',
      guide: put.status === 401 || put.status === 403
        ? 'GitHub token 권한(Contents:write)을 확인하세요.'
        : 'owner/repo/path/branch 설정을 확인하세요.',
    };
  }
  return { ok: false, status: 409, message: '동시 저장 충돌이 계속됩니다. 잠시 후 다시 시도하세요.', guide: '여러 관리자가 동시에 저장 중일 수 있습니다.' };
}

async function handleSaveConfig(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;
  const envErr = checkEnv(env);
  if (envErr) return envErr;

  let body;
  try { body = await request.json(); } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }

  const config = body.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, status: 400, message: 'config 객체가 필요합니다.', guide: '{ "config": {...} } 형태로 전송하세요.' };
  }

  try {
    return await saveGithubJson(env, 'site-config.json', config, 'chore: update site-config from admin');
  } catch (e) {
    return { ok: false, status: 502, message: e.message || String(e), guide: 'GitHub API 호출 중 예외 발생.' };
  }
}

async function handleUploadFile(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;
  const envErr = checkEnv(env);
  if (envErr) return envErr;

  let body;
  try { body = await request.json(); } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }

  const { path, content } = body;
  if (!path || !content) {
    return { ok: false, status: 400, message: 'path와 content(base64)가 필요합니다.' };
  }

  try {
    const currentSha = await getGithubFileSha(env, path);
    const apiBody = {
      message: `upload: ${path}`,
      content: content,
      branch: env.GITHUB_BRANCH,
    };
    if (currentSha) apiBody.sha = currentSha;

    const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
    const res = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'froky-vape-menu-worker',
      },
      body: JSON.stringify(apiBody),
    });

    const data = await res.json();
    if (!res.ok) {
      return { ok: false, status: res.status, message: data.message || '이미지 업로드 실패' };
    }

    const rawUrl = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`;
    return { ok: true, url: rawUrl, path };
  } catch (e) {
    return { ok: false, status: 502, message: e.message || String(e) };
  }
}

async function getGithubFileSha(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'froky-vape-menu-worker',
    },
  });

  if (res.status === 404) return null;

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`GitHub file lookup failed: ${res.status} ${data.message || ''}`);
  }
  return data.sha;
}

async function saveGithubJson(env, path, jsonData, commitMessage) {
  const currentSha = await getGithubFileSha(env, path);

  const contentText = JSON.stringify(jsonData, null, 2);
  const encodedContent = base64EncodeUtf8(contentText);

  const body = {
    message: currentSha ? commitMessage : commitMessage.replace('update', 'create'),
    content: encodedContent,
    branch: env.GITHUB_BRANCH,
  };
  if (currentSha) body.sha = currentSha;

  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'froky-vape-menu-worker',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: data.message || 'GitHub 저장 실패',
      guide: res.status === 422
        ? '기존 파일 업데이트 시 sha가 누락되었거나, 파일이 다른 요청으로 먼저 변경되었을 수 있습니다.'
        : res.status === 409
        ? '다른 커밋과 충돌. 잠시 후 다시 시도하세요.'
        : res.status === 401 || res.status === 403
        ? 'GitHub token 권한(repo 스코프) 또는 fine-grained PAT의 Contents:write 권한을 확인하세요.'
        : 'owner/repo/path/branch 설정을 확인하세요.',
    };
  }

  return {
    ok: true,
    commitUrl: data.commit?.html_url || null,
    contentSha: data.content?.sha || null,
    updatedPath: path,
  };
}

// ── Cafe24 인증 코드 → 토큰 교환 ────────────────────────────────
async function handleCafe24Token(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let body;
  try { body = await request.json(); } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }

  const { client_id, client_secret, code, redirect_uri, mall_id } = body;
  if (!client_id || !client_secret || !code || !redirect_uri || !mall_id) {
    return { ok: false, status: 400, message: 'client_id, client_secret, code, redirect_uri, mall_id가 필요합니다.' };
  }

  const tokenRes = await fetch(`https://${mall_id}.cafe24api.com/api/v2/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${client_id}:${client_secret}`),
    },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirect_uri)}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.error) {
    return {
      ok: false, status: 401,
      message: `토큰 교환 실패: ${tokenData.error_description || tokenData.error || ''}`,
      guide: '인증 코드가 만료되었거나 redirect_uri가 일치하지 않습니다.',
    };
  }

  return {
    ok: true,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_at,
  };
}

// ── Cafe24 상품 조회 ─────────────────────────────────────────────
async function handleCafe24Products(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let body;
  try { body = await request.json(); } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }

  const { client_id, client_secret, refresh_token, mall_id, product_name, offset: reqOffset } = body;
  if (!client_id || !client_secret || !refresh_token || !mall_id) {
    return { ok: false, status: 400, message: 'client_id, client_secret, refresh_token, mall_id가 필요합니다.' };
  }

  // 1단계: Refresh Token으로 Access Token 교환
  const tokenRes = await fetch(`https://${mall_id}.cafe24api.com/api/v2/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${client_id}:${client_secret}`),
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh_token)}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
    return {
      ok: false, status: 401,
      message: `카페24 인증 실패: ${tokenData.error_description || tokenData.error || 'access_token 없음'}`,
      guide: 'Refresh Token이 만료되었을 수 있습니다. 카페24 개발자센터에서 새 토큰을 발급받으세요.',
    };
  }

  // 2단계: 상품 목록 조회
  // offset이 명시적으로 전달되면 해당 페이지 1개만, 없으면 전체 상품을 끝까지 수집
  const limit = 100;
  const singlePage = typeof reqOffset === 'number';
  const startOffset = singlePage ? reqOffset : 0;
  const maxPages = singlePage ? 1 : 1000;
  const allProducts = [];

  for (let page = 0; page < maxPages; page++) {
    const pageOffset = startOffset + page * limit;
    let cafe24ProductsUrl = `https://${mall_id}.cafe24api.com/api/v2/admin/products?limit=${limit}&offset=${pageOffset}`;
    if (product_name) cafe24ProductsUrl += `&product_name=${encodeURIComponent(product_name)}`;

    const prodRes = await fetch(cafe24ProductsUrl, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'X-Cafe24-Api-Version': '2026-03-01',
      },
    });

    const prodData = await prodRes.json();
    if (!prodRes.ok) {
      return {
        ok: false,
        status: prodRes.status,
        endpoint: cafe24ProductsUrl,
        message: `상품 조회 실패 (${cafe24ProductsUrl}): ${JSON.stringify(prodData)}`,
        guide: prodData?.error?.message?.includes('not an allowed client_id')
          ? 'Cloudflare Worker가 최신 코드로 배포되지 않았거나, Cafe24 앱이 Admin Products API 사용 허용 상태가 아닙니다.'
          : 'Cafe24 응답의 error code/message를 확인하세요.',
      };
    }

    const batch = prodData.products || [];
    allProducts.push(...batch);

    if (batch.length < limit) break;
  }

  return {
    ok: true,
    products: allProducts,
    new_refresh_token: tokenData.refresh_token || null,
  };
}
