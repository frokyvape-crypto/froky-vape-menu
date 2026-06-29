# FROKY VAPE Admin Worker

관리자 페이지가 GitHub PAT을 직접 브라우저에 두지 않고, **Cloudflare Worker**를 통해 GitHub Contents API에 안전하게 PUT 하도록 만든 백엔드.

## 엔드포인트

### `PUT /api/github/products`

상품 목록을 `products.json` 으로 저장.

- 헤더
  - `Content-Type: application/json`
  - `X-Admin-Key: <ADMIN_KEY>` — 관리자 인증
- 바디
  ```json
  { "products": [ { "id": 1, "name": "...", "price": 12000, ... } ] }
  ```
- 응답 (성공)
  ```json
  { "ok": true, "commitUrl": "https://github.com/.../commit/abc", "contentSha": "...", "updatedPath": "products.json" }
  ```
- 응답 (실패)
  ```json
  { "ok": false, "status": 422, "message": "...", "guide": "..." }
  ```

### `GET /api/health`
간단한 헬스체크. `{ ok: true, ts }` 반환.

### `POST /api/gsc/summary`

Google Search Console 읽기 전용 요약을 반환.

- 헤더
  - `Content-Type: application/json`
  - `X-Admin-Key: <ADMIN_KEY>`
- 바디
  ```json
  {
    "siteUrl": "https://frokyvape-crypto.github.io/froky-vape-menu/",
    "inspectUrl": "https://frokyvape-crypto.github.io/froky-vape-menu/",
    "days": 28
  }
  ```
- 응답
  - 클릭수, 노출수, CTR, 평균 순위
  - 상위 검색어/페이지
  - 사이트맵 등록 상태
  - 대표 URL 색인 검사 결과
  - 룰 기반 해결방안

## 동작 흐름

1. `X-Admin-Key` 검증
2. 환경변수 검증 (`GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `PRODUCTS_PATH`, `GITHUB_TOKEN`, `ADMIN_KEY`)
3. body의 `products` 배열 검증
4. `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}`
   - `200` → `data.sha` 보관 (기존 파일 업데이트)
   - `404` → `sha` 생략 (신규 파일 생성)
   - 기타 → 에러 응답
5. UTF-8 안전 base64 인코딩 (`TextEncoder` 기반)
6. `PUT /repos/{owner}/{repo}/contents/{path}` 호출

## 배포

```bash
cd worker
npm i -g wrangler
wrangler login
wrangler secret put GITHUB_TOKEN   # repo 스코프 PAT
wrangler secret put ADMIN_KEY      # 관리자 페이지에 입력할 임의의 강한 키
wrangler deploy
```

배포 후 Worker URL이 출력됩니다 (예: `https://froky-vape-admin.<account>.workers.dev`).
이 URL을 관리자 페이지의 **Worker URL** 필드에 입력하세요.

### Search Console 연동 설정

Google Cloud에서 Search Console API를 활성화하고 OAuth client를 만든 뒤, Search Console 권한이 있는 Google 계정으로 refresh token을 발급합니다. scope는 읽기 전용만 사용하세요.

```bash
wrangler secret put GSC_CLIENT_ID
wrangler secret put GSC_CLIENT_SECRET
wrangler secret put GSC_REFRESH_TOKEN
wrangler secret put ADMIN_KEY

wrangler deploy
```

공개 속성 URL은 `wrangler.toml`의 `[vars]` 또는 Cloudflare 대시보드 변수로 설정할 수 있습니다.

```toml
GSC_SITE_URL = "https://frokyvape-crypto.github.io/froky-vape-menu/"
```

Search Console 속성값은 실제 등록값과 정확히 같아야 합니다. URL-prefix 속성은 끝 `/` 포함 여부까지 맞추고, 도메인 속성은 `sc-domain:example.com` 형식을 씁니다.

## 로컬 개발

```bash
wrangler dev
```

## 보안

- `GITHUB_TOKEN`은 Worker secret에만 저장됨. 응답에 포함되지 않음.
- `ADMIN_KEY`는 관리자 페이지에 입력해야만 사용 가능.
- CORS는 `*` 허용 — 정적 사이트에서 호출 가능. 필요 시 `Access-Control-Allow-Origin`을 GitHub Pages 도메인으로 제한 가능.
