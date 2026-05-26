import json
import os
import time
from urllib.parse import urljoin

import requests


MALL_API = "https://frokyvape.cafe24api.com/api/v2"
MALL_HOST = "https://frokyvape.cafe24.com"

CAT_MTL = "\ud3d0\ud638\ud761"
CAT_SALT = "\uace0\ub18d\ub3c4"
CAT_DISPOSABLE = "\uc77c\ud68c\uc6a9"
CAT_DEFAULT = "\uc785\ud638\ud761"

CAT_KEYWORDS = {
    CAT_MTL: [CAT_MTL, "\ubaa8\ub4dc", "RDA", "RTA", "\uc11c\ube0c\uc634"],
    CAT_SALT: ["\uc194\ud2b8", "salt", "Salt", CAT_SALT, "SALT"],
    CAT_DISPOSABLE: [CAT_DISPOSABLE, "\ub514\uc2a4\ud3ec", "Disposable", "disposable"],
    "best": ["\ubca0\uc2a4\ud2b8", "\uc2e0\uc0c1", "\uc778\uae30"],
}


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def normalize_image_url(path):
    if not path:
        return ""
    if path.startswith("//"):
        return "https:" + path
    if path.startswith("http://") or path.startswith("https://"):
        return path
    if path.startswith("/"):
        return urljoin(MALL_HOST, path)
    return path


def get_category(name, tags):
    combined = f"{name} {' '.join(tags or [])}"
    for category, keywords in CAT_KEYWORDS.items():
        if any(keyword in combined for keyword in keywords):
            return category
    return CAT_DEFAULT


def request_json(session, url, **kwargs):
    response = session.get(url, timeout=30, **kwargs)
    if response.status_code != 200:
        raise RuntimeError(f"Cafe24 API error {response.status_code}: {response.text[:500]}")
    return response.json()


def fetch_products(session):
    all_products = []
    offset = 0
    while True:
        data = request_json(
            session,
            f"{MALL_API}/products",
            params={"limit": 100, "offset": offset, "display": "T", "selling": "T"},
        )
        items = data.get("products", [])
        if not items:
            break
        all_products.extend(items)
        print(f"Fetched {len(all_products)} Cafe24 products...")
        if len(items) < 100:
            break
        offset += 100
    return all_products


def fetch_options(session, product_no):
    data = request_json(session, f"{MALL_API}/products/{product_no}/options")
    values = []
    for option_group in data.get("options", []):
        for value in option_group.get("option_value", []):
            text = (value.get("option_text") or "").strip()
            if text and text not in values:
                values.append(text)
    return values


def transform_product(session, product):
    product_no = product["product_no"]
    image = (
        product.get("list_image")
        or product.get("detail_image")
        or product.get("tiny_image")
        or ""
    )

    options = []
    if product.get("has_option") == "T":
        time.sleep(0.1)
        options = fetch_options(session, product_no)

    name = product.get("product_name", "")
    return {
        "id": product_no,
        "name": name,
        "price": int(float(product.get("price", 0) or 0)),
        "img": normalize_image_url(image),
        "flavor": (product.get("summary_description") or "").strip(),
        "cat": get_category(name, product.get("tags", [])),
        "sale": bool(product.get("price_content")),
        "options": options,
    }


def main():
    token = require_env("ACCESS_TOKEN")
    session = requests.Session()
    session.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "X-Cafe24-Api-Version": "2024-03-01",
        }
    )

    products = fetch_products(session)
    result = [transform_product(session, product) for product in products]

    with open("products.json", "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print(f"Wrote products.json with {len(result)} products.")


if __name__ == "__main__":
    main()
