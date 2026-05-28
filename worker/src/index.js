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
        version: '2026-05-28-cafe24-admin-products',
        cafe24ProductsEndpoint: '/api/v2/admin/products',
        ts: Date.now(),
      });
    }

    return jsonResponse({ ok: false, message: 'Not Found' }, 404);
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'PUT, POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
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

function checkAuth(request, env) {
  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return { ok: false, status: 401, message: 'Unauthorized', guide: 'X-Admin-Key 헤더가 누락되었거나 일치하지 않습니다.' };
  }
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

  const products = body.products;
  if (!Array.isArray(products)) {
    return { ok: false, status: 400, message: 'products 배열이 필요합니다.', guide: '{ "products": [...] } 형태로 전송하세요.' };
  }

  try {
    return await saveGithubJson(env, env.PRODUCTS_PATH, products, 'chore: update products from admin');
  } catch (e) {
    return { ok: false, status: 502, message: e.message || String(e), guide: 'GitHub API 호출 중 예외 발생.' };
  }
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

  const { client_id, client_secret, refresh_token, mall_id, product_name, get_all } = body;
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

  // 2단계: 상품 목록 조회 (페이지네이션, 상품명 검색 지원)
  const allProducts = [];
  const limit = 100;
  let offset = 0;
  const maxPages = 20; // 최대 2000개

  for (let page = 0; page < maxPages; page++) {
    let cafe24ProductsUrl = `https://${mall_id}.cafe24api.com/api/v2/admin/products?limit=${limit}&offset=${offset}&display=T&selling=T`;
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

    if (!get_all || batch.length < limit) break;
    offset += limit;
  }

  return {
    ok: true,
    products: allProducts,
    new_refresh_token: tokenData.refresh_token || null,
  };
}
