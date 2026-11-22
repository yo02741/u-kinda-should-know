## 一個 nginx 站在前端與後端前面，設定有三個問題

門診掛號系統的前端是 Vue 3 + Vite，後端是 Flask，用 gunicorn 跑在 9696。部署方式是 Docker：最前面一個 nginx 容器，設定如下（`backend` 是後端容器的名稱）：

```nginx
upstream backend {
    server backend:9696;
    keepalive 16;
    keepalive_timeout 60s;        # gunicorn 的 --keep-alive 設 75，刻意比這裡長
}

server {
    listen 80;

    location / {
        root /etc/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location /api {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```text
瀏覽器 ──▶ nginx 容器 :80
             ├─ /      自己送 /etc/nginx/html 裡的檔案（npm run build 產出的 dist）
             └─ /api   轉給 gunicorn :9696（Flask）
```

nginx 是整個系統的入口：`/` 那一段是前端的交付物，dist 換版、快取規則跟著前端改；`/api` 那一段是路由，後端加路徑、調逾時，這裡也要改。這份設定能用，但有三個問題：

1. **`no-store` 套在整個 `/`。** 帶 hash 的 `assets/index-3f9c2a1b.js` 也不准存，每次開頁都重新下載全部的 JS 與 CSS。櫃台電腦一天開幾十次掛號頁，每次一兩 MB。
2. **dist 怎麼進到容器裡說不清楚。** 可能是建置映像時 COPY 進去，也可能是啟動時用 volume 掛進去。使用者回報「畫面跟測試環境不一樣」時，查不出這台跑的是哪一版前端。
3. **搬上 K8s 時不知道 nginx 該放哪。** 叢集的入口已經有 Ingress 或 Gateway，nginx 要留著當第二層入口，還是只送靜態檔？

這一課處理前兩個；第三個在 [前端與 API 的路徑分流](#/skill/spa-api-routing)。

`location` 比對、`proxy_pass` 的斜線、upstream 與 502/504 在 [nginx：反向代理、靜態檔與 TLS](#/skill/nginx)。

## 前端檔案怎麼進 nginx：建置時打包進映像

先確認現在是哪一種。`docker inspect` 列出容器的掛載點：

```bash
$ docker inspect clinic-nginx --format '{{json .Mounts}}'
[{"Type":"bind","Source":"/srv/clinic/dist","Destination":"/etc/nginx/html","Mode":"ro",...}]
```

有一筆 `Destination` 是 `/etc/nginx/html` 的 bind mount，是執行時掛載：映像裡只有 nginx，前端檔案在主機的 `/srv/clinic/dist`。輸出是 `[]`，dist 是建置時打包進映像的。

| | 建置時 COPY 進映像 | 執行時用 volume 掛載 |
|---|---|---|
| 一個映像代表什麼 | 一個完整的前端版本：nginx 設定加上 dist | 只有 nginx；前端版本取決於主機上那個目錄 |
| 查目前跑哪一版 | 看映像的 tag（commit SHA） | 要登入主機看目錄內容，每台可能不同 |
| 回滾 | 換回上一個 tag | 要找到上一版的 dist 再放回去 |
| 在 K8s 上 | 一般的 Deployment 就能跑，Pod 排到哪個節點都一樣 | 要把檔案放進每個節點能存取的 volume，見 [Kubernetes 儲存](#/skill/k8s-storage) |
| 更新前端 | 重建映像、滾動更新 | 換目錄內容，nginx 不用重啟，但沒有版本紀錄 |

建議用建置時打包：dist 和 nginx 設定一起變成不可變的映像，套得上 [環境設定與 12-factor](#/skill/config-12factor) 的「建置、發布、執行分開」，同一個映像從測試推到正式。多階段 Dockerfile：

```dockerfile
# ---- build：照 lock 檔裝依賴、建置 ----
FROM node:24-alpine AS build
WORKDIR /app
# 先只複製 package.json 與 lock 檔：原始碼改了，npm ci 這一層還能用快取
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG GIT_SHA=unknown
# 建置後多寫一個 version.json，之後 curl /version.json 就知道跑的是哪一版
RUN npm run build \
 && printf '{"commit":"%s"}\n' "$GIT_SHA" > dist/version.json

# ---- runtime：只有 nginx、設定與 dist ----
FROM nginx/nginx-unprivileged:1.30-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

```bash
docker build --build-arg GIT_SHA=3f9c2a1b -t registry.gitlab.example/clinic/web:3f9c2a1b .
```

`nginx/nginx-unprivileged` 以非 root 執行、預設聽 8080，所以 `default.conf` 要寫 `listen 8080;`；`COPY --from=build` 的目的地要和 `default.conf` 的 `root` 一致。

## 快取：index.html 每次驗證，帶 hash 的檔案存一年

Vite 建置出的 JS、CSS 都在 `dist/assets/` 底下，檔名帶內容的 hash（`index-3f9c2a1b.js`）。內容一改檔名就變，同一個檔名可以存很久。`index.html` 檔名固定，又決定要載入哪些 assets，要每次向伺服器確認（理由見 [HTTP 快取](#/skill/http-caching)）：

```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;

    # 入口：可以存，但每次都要確認；沒變就回 304，新版部署後下一次載入就拿到
    location = /index.html {
        add_header Cache-Control "no-cache" always;
    }

    # 帶 hash 的檔案：一年內不用再問
    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # 執行期設定（下一課）：內容會換、檔名不變，跟 index.html 一樣
    location = /config.js {
        add_header Cache-Control "no-cache" always;
    }

    location /api/ {
        # ...轉給後端，跟原本一樣；API 的快取由後端的回應標頭決定
    }

    # 其他路徑：有檔案就送檔案（favicon.ico、version.json），沒有就交給前端路由
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
    }
}
```

最常見的兩個錯誤：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 打開網站是 nginx 的歡迎頁，或 403 | dist 複製到的目錄和 `root` 不一致 | 讓 `COPY --from=build` 的目的地等於 `root` |
| `bind() to 0.0.0.0:80 failed (13: Permission denied)` | 非 root 執行卻聽 80 | 聽 8080（unprivileged 映像的預設），Service 的 `targetPort` 跟著改 |

:::stop 讀到這裡可以先停：會建只送靜態檔的前端映像，並把 `index.html` 與帶 hash 的檔案分開快取。完成條件：`curl -sI` 打 `/patients/123` 與 `/assets/<檔名>` 分別得到 `no-cache` 與 `immutable`，`/assets/not-exist.js` 回 404。後面兩章是這個映像的細節（`npm ci`、`.dockerignore`、非 root、`add_header` 的繼承），建置出錯或要加安全標頭時再回來讀。

## 前端映像的細節：npm ci、`.dockerignore`、非 root

- **用 `npm ci`**：`npm ci` 完全照 `package-lock.json` 安裝，lock 檔與 `package.json` 對不上時直接失敗；`npm install` 可能順手更新 lock 檔，同一個 commit 兩次建置裝到不同版本。
- **最後一個階段只拿 `dist`**：node、`node_modules`、原始碼都留在 build 階段，最終映像只有 nginx 與幾 MB 的靜態檔。多階段建置的原理見 [幫 Python 專案寫好 Dockerfile](#/skill/dockerfile-python)。
- **COPY 的目的地要和 `root` 一致**：官方映像預設的 root 是 `/usr/share/nginx/html`；原本設定裡的 `/etc/nginx/html` 也可以，只要 `COPY --from=build` 的目的地和 `default.conf` 的 `root` 寫同一個路徑。
- **base image 釘版本**：`node:24-alpine` 釘大版本，`1.30-alpine` 是 nginx 的穩定版分支（2026 年 11 月時 Docker Hub 上的穩定版是 1.30.x、主線版是 1.31.x）。要每次建置都完全一樣，改釘 digest，見 [Docker 基礎](#/skill/docker-basics)。

`.dockerignore`：

```text
node_modules
dist
.git
coverage
*.log
.env.local
.env.*.local
```

`node_modules` 一定要排除。Vite 的打包工具帶有依作業系統編譯的原生套件，開發機（macOS 或 Windows）裝的那一份被 `COPY . .` 蓋進 Linux 容器，建置時會找不到對應平台的模組。`dist` 排除是為了不讓本機舊的建置結果混進去。Vite 會讀 `.env` 與 `.env.production`，這兩個檔可以留；`.local` 結尾的是個人本機設定，不進映像。

### 以非 root 執行

官方的 `nginx` 映像由 root 啟動 master 行程、聽 80，pid 檔與暫存目錄也放在只有 root 能寫的位置。要以非 root 執行有兩種做法：

| 做法 | 內容 |
|---|---|
| 改用 `nginx/nginx-unprivileged` | NGINX 官方維護的變體：預設聽 8080、以 UID 101 執行、pid 檔與 `*_temp_path` 都改到 `/tmp`。Docker Hub 上舊的名稱是 `nginxinc/nginx-unprivileged`，1.30.6（穩定版）、1.31.7（主線版）起的版本放在 `nginx/nginx-unprivileged`，也有 GHCR 與 Amazon ECR 的鏡像 |
| 官方映像自己改 | `listen` 改成 1024 以上的 port、`pid` 改到 `/tmp/nginx.pid`、`*_temp_path` 改到可寫的目錄，再用 `USER` 切到非 root。Docker Hub 的官方映像說明列了要改的指令 |

上面的 Dockerfile 用第一種，所以 `default.conf` 要寫 `listen 8080;`。把原本 `listen 80;` 的設定直接搬過去，在不允許非 root 綁低 port 的環境，nginx 會啟動失敗並印出 `bind() to 0.0.0.0:80 failed (13: Permission denied)`。

## 快取設定的細節：深層連結、`add_header` 不繼承、下載量模擬

- **深層連結也會拿到 `no-cache`。** 使用者直接開 `/patients/123`，`location /` 的 `try_files` 找不到這個檔案，最後一個參數 `/index.html` 是一次內部轉址：nginx 用新的路徑重新選 location，選到 `location = /index.html`，所以回應帶的是那一段的標頭。
- **`/assets/` 底下找不到檔案要回 404。** 原本的設定裡，不存在的 `/assets/Billing-77aa1c2e.js` 也會被 `try_files` 換成 `index.html`，回 200、`Content-Type: text/html`，瀏覽器拒絕把它當成 JS 執行。`try_files $uri =404;` 把這件事寫明，也避免日後有人在這裡加上 `/index.html` 的 fallback，讓一份 HTML 以一年的快取存在 `.js` 的網址下。

nginx 對靜態檔預設會送 `ETag` 與 `Last-Modified`，`no-cache` 的檔案在第二次載入時由瀏覽器帶條件請求，沒變回 304，只傳標頭。

### add_header 在巢狀層級不繼承

原本的設定只有一個 location 寫了 `add_header`，所以沒踩到這個陷阱。拆成好幾個 location 之後，很容易寫出這種設定：

```nginx
server {
    add_header X-Content-Type-Options "nosniff" always;    # 想套到整個站

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        # 這一層有自己的 add_header：上面那個 nosniff 不會出現在 /assets/ 的回應裡
    }
}
```

nginx 的規則是：**只有在目前這一層完全沒有 `add_header` 時**，才繼承上一層的 `add_header`；這一層只要寫了一個，上一層的就全部不算。`proxy_set_header` 也是同樣的規則。處理方式：

- 每個有 `add_header` 的 location 把共用的標頭再寫一次，或把共用的標頭放在一個檔案裡，在每個 location `include` 進來。
- nginx 1.29.3 起有 `add_header_inherit` 指令，`add_header_inherit merge;` 讓下層除了自己的 `add_header`，也保留上一層的（1.30 穩定版已包含）。更舊的版本 `nginx -t` 會報 `unknown directive "add_header_inherit"`，用之前確認映像的 nginx 版本。

另外，沒有加 `always` 的 `add_header` 只會出現在 200、201、204、206、301、302、303、304、307、308 的回應上，404 與 5xx 不會帶。

### 第二次開頁要下載多少

下面的模擬照 nginx 的規則選 location、套用 `add_header` 的繼承規則，再依 `Cache-Control` 決定瀏覽器第二次開頁時哪些檔案不用問、哪些拿到 304、哪些要整個重新下載。檔案大小是示意數字：

```python run
# 兩份 nginx 設定，同一組 dist。location 依 nginx 的規則選：先找 = 精確比對，再找最長前綴。
# add_header 只有在「這一層自己沒有任何 add_header」時，才繼承上一層（server）的。
NOSNIFF = ("X-Content-Type-Options", "nosniff")

ORIGINAL = {                     # 現在的設定：整個 / 都 no-store
    "server": [],
    "locations": [
        ("prefix", "/", "spa", [("Cache-Control", "no-cache, no-store, must-revalidate")]),
        ("prefix", "/api", "proxy", []),
    ],
}
FIXED = {                        # 修正後：index.html 每次驗證、/assets/ 存一年
    "server": [NOSNIFF],
    "locations": [
        ("exact", "/index.html", "file", [("Cache-Control", "no-cache"), NOSNIFF]),
        ("exact", "/config.js", "file", [("Cache-Control", "no-cache"), NOSNIFF]),
        ("prefix", "/assets/", "file", [("Cache-Control", "public, max-age=31536000, immutable"), NOSNIFF]),
        ("prefix", "/api/", "proxy", []),
        ("prefix", "/", "spa", [("Cache-Control", "no-cache"), NOSNIFF]),
    ],
}

# 示意的檔案：路徑 -> (KB，壓縮後的傳輸量；內容版本，相當於 ETag)
V1 = {"/index.html": (1.2, "v1"), "/config.js": (0.2, "c1"), "/favicon.ico": (4, "f1"),
      "/assets/index-3f9c2a1b.js": (480, "a"), "/assets/vendor-8d1e7f40.js": (620, "b"),
      "/assets/index-5b2e9c11.css": (60, "c")}
# v2 只改了業務程式：index.html 換了內容、index 的 hash 變了；vendor 與 css 沒變，檔名也沒變
V2 = {k: v for k, v in V1.items() if k != "/assets/index-3f9c2a1b.js"}
V2.update({"/index.html": (1.2, "v2"), "/assets/index-a1b2c3d4.js": (482, "d")})

def page(dist):                  # 開一次 /patients/123 會發出的請求
    return ["/patients/123", "/config.js", "/favicon.ico"] + sorted(k for k in dist if k.startswith("/assets/"))

def choose(conf, uri):
    for kind, path, action, hdrs in conf["locations"]:
        if kind == "exact" and uri == path:
            return path, action, hdrs
    hits = [(p, a, h) for k, p, a, h in conf["locations"] if k == "prefix" and uri.startswith(p)]
    return max(hits, key=lambda x: len(x[0]))

def serve(conf, dist, uri):
    """回傳 (實際送出的檔案, 回應標頭, 處理它的 location)"""
    path, action, hdrs = choose(conf, uri)
    if action == "spa" and uri not in dist:          # try_files 找不到檔案：內部轉到 /index.html，重新選 location
        return serve(conf, dist, "/index.html")
    headers = dict(hdrs or conf["server"])          # 這一層有 add_header，就只用自己的
    return uri, headers, path

VERSIONS = {"v1": V1, "v2": V2}             # index.html 的版本 → 它引用的那一組 assets

def fetch(conf, dist, cache, uri):
    """回傳 (下載的 KB, 有沒有發出請求, 瀏覽器最後用的內容版本)"""
    file, headers, _ = serve(conf, dist, uri)
    cc = headers.get("Cache-Control", "")
    fresh = "max-age=" in cc and "no-cache" not in cc and "no-store" not in cc
    if uri in cache and fresh:                  # 還在新鮮期：不發請求，直接用存著的
        return 0, False, cache[uri]
    if file not in dist:
        return 0, True, None                    # 404
    size, version = dist[file]
    if cache.get(uri) == version:               # 條件請求，內容沒變回 304，不傳 body
        return 0, True, version
    if "no-store" not in cc:
        cache[uri] = version
    return size, True, version                  # 200：整個檔案下載

def visit(conf, dist, cache):
    kb, sent, used = fetch(conf, dist, cache, "/patients/123")
    reqs = int(sent)
    assets = sorted(k for k in VERSIONS[used] if k.startswith("/assets/"))   # 舊的 index.html 會去要舊的 assets
    for uri in ["/config.js", "/favicon.ico"] + assets:
        size, sent, _ = fetch(conf, dist, cache, uri)
        kb, reqs = kb + size, reqs + int(sent)
    return kb, reqs, used != dist["/index.html"][1]

for name, conf in [("原本的設定", ORIGINAL), ("修正後", FIXED)]:
    print(f"== {name}")
    for uri in page(V1) + ["/api/patients"]:
        file, headers, loc = serve(conf, V1, uri)
        if loc.startswith("/api"):
            print(f"  {uri:<27} location {loc:<12} 轉給後端，Cache-Control 由後端決定")
            continue
        cc = headers.get("Cache-Control", "（沒有）")
        sniff = "nosniff" if NOSNIFF in headers.items() else "沒有 nosniff"
        sent = "" if file == uri else f"（送 {file}）"
        print(f"  {uri:<27} location {loc:<12} {cc}；{sniff}{sent}")
    cache = {}
    for title, dist in [("第一次開頁", V1), ("第二次開頁", V1), ("部署 v2 之後第一次開頁", V2)]:
        kb, reqs, stale = visit(conf, dist, cache)
        note = "；用的是快取裡的舊 index.html，畫面還是舊版" if stale else ""
        print(f"  {title}：發出 {reqs} 個請求，下載 {kb:,.1f} KB{note}")
    print()
```

原本的設定每次開頁都是 1.1 MB 左右；修正後第二次開頁只剩三個條件請求、沒有 body。部署 v2 之後，`index.html` 的 ETag 變了，拿到新內容，引用的 `index-a1b2c3d4.js` 是新網址所以下載，`vendor` 與 CSS 的檔名沒變，直接用快取。`/patients/123` 那一列顯示內部轉址後實際送出的是 `/index.html`。

## 常見錯誤與錯誤訊息

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 每次開頁都重新下載全部 JS，Network 分頁看不到 `(disk cache)` | `no-store` 套到了 `/assets/` | index.html 用 `no-cache`，`/assets/` 用長效快取 |
| 部署後使用者一直看到舊版，重新整理才好 | `index.html` 被長效快取，或被 `/assets/` 那類設定套到 | `index.html`（包含 SPA fallback）要是 `no-cache` |
| 某個 location 的回應少了 `X-Content-Type-Options` 之類的安全標頭 | 那個 location 有自己的 `add_header`，不再繼承 server 層 | 每個 location 重寫一次、用 `include`，或 1.29.3 起的 `add_header_inherit merge` |
| `npm ci can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync` | lock 檔沒有跟著 `package.json` 更新 | 本機 `npm install` 更新 lock 檔並 commit |
| 建置時 `Cannot find module @rollup/rollup-linux-x64-musl` 這類訊息（套件名稱依 Vite 版本而異） | 開發機的 `node_modules` 被複製進容器 | `.dockerignore` 排除 `node_modules`，在容器裡 `npm ci` |

## 動手

1. 執行快取那段模擬。把 `FIXED` 裡 `/assets/` 那一行的 `NOSNIFF` 刪掉再跑，看 assets 的回應少了 nosniff（server 層還有，但那一層有自己的 `add_header`）；再把 `/index.html` 的值改成 `public, max-age=86400`，看部署 v2 之後下載了多少、拿到的是不是新版。
2. 做本課的程式題：修一份前端的多階段 Dockerfile；修一份 nginx 設定的快取標頭，同時保留 SPA fallback 與 `/api` 轉發。
3. 把這個映像部署到本機叢集、用 `curl` 驗收快取標頭的步驟，在 [前端的執行期設定](#/skill/spa-runtime-config) 的「動手」。

接下來：換環境就要重建映像時讀 [前端的執行期設定](#/skill/spa-runtime-config)；要把 `/api` 搬上 Kubernetes 時讀 [前端與 API 的路徑分流](#/skill/spa-api-routing)。
