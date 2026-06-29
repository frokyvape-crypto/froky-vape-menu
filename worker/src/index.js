// FROKY VAPE Admin — Cloudflare Worker
// PUT /api/github/products  → products.json 저장
// PUT /api/github/config    → site-config.json 저장
// PUT /api/github/upload    → 이미지 파일 업로드
// POST /api/cafe24/products → 카페24 상품 목록 조회
// POST /api/cafe24/token    → 카페24 OAuth 코드→토큰 교환
// POST /api/gsc/summary     → Google Search Console 읽기 전용 요약
// GET /api/health
//
// Environment:
//   vars:    GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, PRODUCTS_PATH
//   secret:  GITHUB_TOKEN, ADMIN_KEY
// Optional GSC:
//   vars:    GSC_SITE_URL
//   secret:  GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN

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

    if (url.pathname === '/api/gsc/summary' && request.method === 'POST') {
      const result = await handleGscSummary(request, env);
      const status = result.ok ? 200 : (result.status || 500);
      return jsonResponse(result, status);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({
        ok: true,
        version: '2026-05-28-cafe24-all-products',
        cafe24ProductsEndpoint: '/api/v2/admin/products',
        cafe24ProductsScope: 'all',
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

async function handleGscSummary(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  for (const key of ['GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_REFRESH_TOKEN']) {
    if (!env[key]) {
      return {
        ok: false,
        status: 500,
        message: `GSC 설정 ${key} 누락`,
        guide: 'wrangler secret put 으로 Google OAuth 값을 설정하세요.',
      };
    }
  }

  let body = {};
  try { body = await request.json(); } catch {}

  const siteUrl = String(body.siteUrl || env.GSC_SITE_URL || '').trim();
  if (!siteUrl) {
    return { ok: false, status: 400, message: 'Search Console siteUrl이 필요합니다.' };
  }

  const days = Math.min(Math.max(Number(body.days || 28), 7), 90);
  const range = makeGscDateRange(days);
  const previousRange = makePreviousDateRange(range);
  const token = await getGoogleAccessToken(env);

  try {
    const [total, previousTotal, queries, pages, sitemaps, inspection] = await Promise.all([
      querySearchAnalytics(token, siteUrl, range, []),
      querySearchAnalytics(token, siteUrl, previousRange, []),
      querySearchAnalytics(token, siteUrl, range, ['query'], 10),
      querySearchAnalytics(token, siteUrl, range, ['page'], 10),
      listGscSitemaps(token, siteUrl),
      inspectGscUrl(token, siteUrl, body.inspectUrl),
    ]);

    return {
      ok: true,
      siteUrl,
      range,
      total: firstRow(total),
      previousTotal: firstRow(previousTotal),
      queries: queries.rows || [],
      pages: pages.rows || [],
      sitemaps,
      inspection,
      recommendations: makeGscRecommendations({
        total: firstRow(total),
        previousTotal: firstRow(previousTotal),
        queries: queries.rows || [],
        pages: pages.rows || [],
        sitemaps,
        inspection,
      }),
    };
  } catch (e) {
    return { ok: false, status: e.status || 502, message: e.message || String(e) };
  }
}

function makeGscDateRange(days) {
  // Search Console data is delayed; use a conservative 3-day lag.
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: isoDate(start), endDate: isoDate(end), days };
}

function makePreviousDateRange(range) {
  const end = new Date(range.startDate + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - range.days + 1);
  return { startDate: isoDate(start), endDate: isoDate(end), days: range.days };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function getGoogleAccessToken(env) {
  const params = new URLSearchParams({
    client_id: env.GSC_CLIENT_ID,
    client_secret: env.GSC_CLIENT_SECRET,
    refresh_token: env.GSC_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description || data.error || `Google token failed: ${res.status}`);
    err.status = 502;
    throw err;
  }
  return data.access_token;
}

async function querySearchAnalytics(token, siteUrl, range, dimensions = [], rowLimit = 1) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions,
      rowLimit,
      dataState: 'final',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Search Analytics failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function firstRow(data) {
  const row = data?.rows?.[0] || {};
  return {
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    position: row.position || 0,
  };
}

async function listGscSitemaps(token, siteUrl) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`;
  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error?.message || `Sitemaps failed: ${res.status}`, sitemap: [] };
  return data;
}

async function inspectGscUrl(token, siteUrl, inspectUrl) {
  const target = String(inspectUrl || defaultInspectionUrl(siteUrl) || '').trim();
  if (!target || !/^https?:\/\//i.test(target)) return null;
  const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inspectionUrl: target,
      siteUrl,
      languageCode: 'ko-KR',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error?.message || `URL Inspection failed: ${res.status}` };
  return data;
}

function defaultInspectionUrl(siteUrl) {
  if (/^https?:\/\//i.test(siteUrl)) return siteUrl;
  if (siteUrl.startsWith('sc-domain:')) return `https://${siteUrl.replace('sc-domain:', '')}/`;
  return '';
}

function makeGscRecommendations({ total, previousTotal, queries, pages, sitemaps, inspection }) {
  const items = [];
  const sitemapCount = sitemaps?.sitemap?.length || 0;
  if (!sitemapCount) {
    items.push({
      level: 'warn',
      label: 'SITEMAP',
      title: '사이트맵 제출 확인',
      detail: 'sitemap.xml 파일을 만들었더라도 Search Console에 제출되어야 색인 발견 속도를 높일 수 있습니다.',
    });
  }
  if ((total.impressions || 0) > 50 && (total.ctr || 0) < 0.01) {
    items.push({
      level: 'bad',
      label: 'CTR',
      title: '노출 대비 클릭률이 낮습니다',
      detail: '검색 결과에서 보이는 사이트 제목, 설명, 대표 상품명 문구가 검색 의도와 맞는지 점검하세요.',
    });
  }
  if ((total.position || 0) > 15 && (total.impressions || 0) > 20) {
    items.push({
      level: 'warn',
      label: 'RANK',
      title: '평균 순위가 낮습니다',
      detail: '카테고리별 설명 문구, 상품 상세 텍스트, 지역/브랜드 키워드를 메인 콘텐츠에 보강하는 것이 좋습니다.',
    });
  }
  if ((previousTotal.clicks || 0) && total.clicks < previousTotal.clicks * 0.7) {
    items.push({
      level: 'bad',
      label: 'DROP',
      title: '이전 기간 대비 클릭이 크게 줄었습니다',
      detail: '최근 공지/상품 변경, 배포 상태, robots.txt, Search Console 수동 조치와 색인 제외 URL을 확인하세요.',
    });
  }
  const highImpressionNoClick = queries.find(row => (row.impressions || 0) >= 20 && !(row.clicks || 0));
  if (highImpressionNoClick) {
    items.push({
      level: 'warn',
      label: 'QUERY',
      title: `"${highImpressionNoClick.keys?.[0] || '검색어'}" 검색어를 개선 후보로 보세요`,
      detail: '노출은 있지만 클릭이 없는 검색어입니다. 메인 문구나 상품명에 더 자연스럽게 반영할 여지가 있습니다.',
    });
  }
  const indexResult = inspection?.inspectionResult?.indexStatusResult;
  if (indexResult && indexResult.verdict !== 'PASS') {
    items.push({
      level: 'bad',
      label: 'INDEX',
      title: '대표 URL 색인 상태를 확인해야 합니다',
      detail: indexResult.coverageState || 'URL Inspection 결과가 PASS가 아닙니다.',
    });
  }
  if (!pages.length) {
    items.push({
      level: 'warn',
      label: 'PAGE',
      title: '페이지 단위 검색 데이터가 부족합니다',
      detail: '현재 쇼핑몰이 단일 페이지 중심이면 상품별 상세 URL이 없어 검색 노출 확장에 한계가 있습니다.',
    });
  }
  return items;
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
