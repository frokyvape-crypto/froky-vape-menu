// FROKY VAPE Admin — Cloudflare Worker
// PUT /api/github/products
//   Headers: X-Admin-Key
//   Body:    { products: [...] }
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

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, ts: Date.now() });
    }

    return jsonResponse({ ok: false, message: 'Not Found' }, 404);
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'PUT, GET, OPTIONS',
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

async function handleSaveProducts(request, env) {
  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return {
      ok: false, status: 401,
      message: 'Unauthorized',
      guide: 'X-Admin-Key 헤더가 누락되었거나 일치하지 않습니다.',
    };
  }

  for (const k of REQUIRED_VARS) {
    if (!env[k]) {
      return {
        ok: false, status: 500,
        message: `환경변수 ${k} 누락`,
        guide: 'wrangler.toml vars 또는 wrangler secret put 으로 설정하세요.',
      };
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body', guide: 'request body는 JSON 이어야 합니다.' };
  }

  const products = body.products;
  if (!Array.isArray(products)) {
    return { ok: false, status: 400, message: 'products 배열이 필요합니다.', guide: '{ "products": [...] } 형태로 전송하세요.' };
  }

  try {
    return await saveGithubFile(env, env.PRODUCTS_PATH, products);
  } catch (e) {
    return { ok: false, status: 502, message: e.message || String(e), guide: 'GitHub API 호출 중 예외 발생.' };
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

async function saveGithubFile(env, path, jsonData) {
  const currentSha = await getGithubFileSha(env, path);

  const contentText = JSON.stringify(jsonData, null, 2);
  const encodedContent = base64EncodeUtf8(contentText);

  const body = {
    message: currentSha ? 'chore: update products from admin' : 'chore: create products from admin',
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
        ? '기존 파일 업데이트 시 sha가 누락되었거나, 파일이 다른 요청으로 먼저 변경되었을 수 있습니다. 저장 직전에 파일 sha를 다시 조회하도록 수정해야 합니다.'
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
