from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx, os, json
from datetime import datetime, timedelta

app = FastAPI(title="FROKY VAPE API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://frokyvape-crypto.github.io"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

CLIENT_ID     = os.environ["CAFE24_CLIENT_ID"]
CLIENT_SECRET = os.environ["CAFE24_CLIENT_SECRET"]
MALL_ID       = os.environ.get("CAFE24_MALL_ID", "frokyvape")
REDIRECT_URI  = os.environ.get("REDIRECT_URI", "https://froky-vape-api.up.railway.app/callback")
TOKEN_FILE    = "/tmp/tokens.json"

def load_tokens():
    try:
        with open(TOKEN_FILE) as f:
            return json.load(f)
    except:
        return {}

def save_tokens(t):
    with open(TOKEN_FILE, "w") as f:
        json.dump(t, f)

async def get_valid_token():
    t = load_tokens()
    if not t.get("access_token"):
        raise HTTPException(401, "OAuth 인증 필요 — /auth-url 을 방문해 인증하세요.")
    if datetime.now() >= datetime.fromisoformat(t["expires_at"]) - timedelta(minutes=5):
        async with httpx.AsyncClient() as c:
            r = await c.post(
                f"https://{MALL_ID}.cafe24api.com/api/v2/oauth/token",
                data={"grant_type": "refresh_token", "refresh_token": t["refresh_token"]},
                auth=(CLIENT_ID, CLIENT_SECRET),
            )
            if r.status_code != 200:
                raise HTTPException(401, "토큰 갱신 실패 — 재인증 필요")
            d = r.json()
            t = {
                "access_token":  d["access_token"],
                "refresh_token": d["refresh_token"],
                "expires_at":    (datetime.now() + timedelta(seconds=d.get("expires_in", 7200))).isoformat(),
            }
            save_tokens(t)
    return t["access_token"]

@app.get("/")
def root():
    return {"status": "FROKY VAPE API running ✅"}

@app.get("/auth-url")
def auth_url():
    return {
        "url": (
            f"https://{MALL_ID}.cafe24api.com/api/v2/oauth/authorize"
            f"?response_type=code&client_id={CLIENT_ID}"
            f"&redirect_uri={REDIRECT_URI}&scope=mall.read_product"
        )
    }

@app.get("/callback")
async def callback(code: str):
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"https://{MALL_ID}.cafe24api.com/api/v2/oauth/token",
            data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI},
            auth=(CLIENT_ID, CLIENT_SECRET),
        )
        if r.status_code != 200:
            raise HTTPException(400, r.text)
        d = r.json()
        save_tokens({
            "access_token":  d["access_token"],
            "refresh_token": d["refresh_token"],
            "expires_at":    (datetime.now() + timedelta(seconds=d.get("expires_in", 7200))).isoformat(),
        })
    return {"message": "✅ 인증 완료! 상품 API 사용 가능합니다."}

@app.get("/products")
async def get_products():
    token = await get_valid_token()
    all_products = []
    offset = 0
    async with httpx.AsyncClient() as c:
        while True:
            r = await c.get(
                f"https://{MALL_ID}.cafe24api.com/api/v2/products",
                headers={"Authorization": f"Bearer {token}", "X-Cafe24-Api-Version": "2024-03-01"},
                params={"limit": 100, "offset": offset, "display": "T", "selling": "T"},
            )
            if r.status_code != 200:
                raise HTTPException(r.status_code, r.text)
            items = r.json().get("products", [])
            if not items:
                break
            all_products.extend(items)
            if len(items) < 100:
                break
            offset += 100

    result = []
    for p in all_products:
        img = p.get("detail_image") or p.get("list_image") or p.get("tiny_image") or ""
        if img and img.startswith("/"):
            img = f"https://{MALL_ID}.cafe24.com{img}"
        result.append({
            "id":      p["product_no"],
            "name":    p["product_name"],
            "price":   int(float(p.get("price", 0))),
            "img":     img,
            "flavor":  p.get("summary_description") or "",
            "cat":     "입호흡",
            "sale":    False,
            "options": [],
        })
    return result
