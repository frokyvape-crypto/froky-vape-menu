# FROKY VAPE Admin Worker

관리자 페이지가 GitHub PAT을 직접 브라우저에 두지 않고, **Cloudflare Worker**를 통해 GitHub Contents API에 안전하게 PUT 하도록 만든 백엔드.

## 엔드포인트

### `GET /api/catalog/products`, `GET /api/catalog/config`

사용자 페이지가 GitHub Pages 배포를 기다리지 않고 `main` 브랜치의 최신 상품과 설정을 읽는 공개 조회 API입니다.

- 응답: `{ "ok": true, "data": ..., "sha": "...", "source": "github-main" }`
- GitHub 토큰은 Worker 내부에서만 사용하며 응답에 포함하지 않습니다.
- GitHub API 호출 폭증을 막기 위해 Cloudflare Cache에 3초간 공유 캐시합니다.
- 관리자 저장 성공 시 해당 캐시를 즉시 삭제합니다.
- 사용자 페이지는 이 API가 실패하면 기존 GitHub Pages JSON으로 자동 전환합니다.

### `PUT /api/github/products`

변경된 상품(ops)을 최신 `products.json` 위에 병합해 저장.

- 헤더
  - `Content-Type: application/json`
  - `X-Admin-Key: <ADMIN_KEY>` — 관리자 인증
- 바디
  ```json
  { "ops": [ { "type": "upsert", "product": { "id": 1, "name": "...", "price": 12000 } }, { "type": "delete", "id": 2 } ] }
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

## 동작 흐름

1. `X-Admin-Key` 검증
2. 환경변수 검증 (`GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `PRODUCTS_PATH`, `GITHUB_TOKEN`, `ADMIN_KEY`)
3. body의 `ops` 배열 검증 (전체 목록 덮어쓰기는 받지 않음)
4. GitHub에서 최신 `products.json`과 `sha`를 읽음 (1MB 초과 파일은 원본 형식으로 다시 읽음)
5. 목록을 읽지 못하면 저장 중단, 읽으면 ops 병합
6. 읽은 `sha`로 PUT, 충돌하면 다시 읽어 최대 5회 재시도

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

## 로컬 개발

```bash
wrangler dev
```

## 보안

- `GITHUB_TOKEN`은 Worker secret에만 저장됨. 응답에 포함되지 않음.
- `ADMIN_KEY`는 관리자 페이지에 입력해야만 사용 가능.
- CORS는 `*` 허용 — 정적 사이트에서 호출 가능. 필요 시 `Access-Control-Allow-Origin`을 GitHub Pages 도메인으로 제한 가능.
