## 搬上 Kubernetes，轉發 `/api` 的 nginx 該放哪

接在 [前端與 nginx 上 K8s](#/skill/spa-containers) 與 [前端的執行期設定](#/skill/spa-runtime-config) 之後。門診掛號系統原本用 Docker 部署，最前面一個 nginx：`/` 送前端的靜態檔，`/api` 轉給後端（Flask，用 gunicorn 跑在 9696）：

```nginx
upstream backend {
    server backend:9696;
    keepalive 16;
    keepalive_timeout 60s;        # gunicorn 的 --keep-alive 設 75，刻意比這裡長
}

server {
    listen 80;
    # ...location / 送靜態檔...

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

搬上 Kubernetes 之後，叢集的入口是 Gateway（或 Ingress），nginx 有兩種放法：

```text
第一條路：保留 nginx 當入口
  瀏覽器 ─▶ Gateway ─▶ Service clinic-web ─▶ nginx Pod ─┬─ /      靜態檔
                                                        └─ /api   ─▶ Service clinic-api ─▶ gunicorn Pod

第二條路：由 Gateway 依路徑分流
  瀏覽器 ─▶ Gateway ─┬─ /     ─▶ Service clinic-web ─▶ nginx Pod（只送靜態檔）
                     └─ /api  ─▶ Service clinic-api ─▶ gunicorn Pod
```

| | 第一條路：保留 nginx 當入口 | 第二條路：Gateway 依路徑分流 |
|---|---|---|
| nginx 設定 | 幾乎不動，upstream 改成 Service 名稱 | 拿掉 `/api`，只剩靜態檔與快取 |
| 同源 | 跟現在一樣，`/api` 與頁面同源，不用 CORS | 同一個 hostname，也是同源；把 API 拆到另一個網域才需要 CORS |
| 一個 `/api` 請求經過 | Gateway、nginx、gunicorn，多一跳 | Gateway、gunicorn |
| 路由規則 | HTTPRoute 與 nginx 兩層，要一起改 | 只有 HTTPRoute |
| 前端與後端分開更新、擴展 | `/api` 的轉發寫在前端的映像裡，後端加一段路徑可能要重建前端 | 各自獨立 |
| 逾時、上傳大小、轉發標頭 | 兩層都要設，以較嚴的那層為準 | 設在 Gateway（各實作的 policy） |
| NetworkPolicy | 放行 web 到 api | 放行 Gateway 的代理 Pod 到 api |
| 適合 | 先求搬上去，設定少改 | 團隊能維護 HTTPRoute，前後端由不同人負責 |

## 第二條路的最小設定：HTTPRoute 依路徑分流

這一課照現有的系統用 9696。實作路線的 `clinic-api` 聽 8000、Service 是 80 對到 8000，換成那組數字接法一樣。

兩條路共用 `clinic-web` 的 Deployment 與 Service（在 [前端的執行期設定](#/skill/spa-runtime-config)）和後端的 Service。後端的 Service 把 port 也寫成 9696，nginx 的設定就只要換主機名稱：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: clinic-api
  namespace: clinic
spec:
  selector:
    app: clinic-api
  ports:
    - name: http
      port: 9696
      targetPort: 9696
```

第二條路，nginx 的 `default.conf` 拿掉 `upstream` 與 `location /api/`，只剩靜態檔與快取。路由寫在 HTTPRoute：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: clinic
  namespace: clinic
spec:
  parentRefs:
    - name: clinic-gateway
  hostnames: ["clinic.example"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /api }
      backendRefs:
        - name: clinic-api
          port: 9696
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: clinic-web
          port: 80
```

兩條規則的順序不影響結果。Gateway API 規定的優先序是 `Exact` 先於 `PathPrefix`，`PathPrefix` 之間比字元數，長的優先，所以 `/api/patients` 由 `/api` 那條接走。`PathPrefix` 是一段一段比：`/api` 符合 `/api`、`/api/`、`/api/patients`，不符合 `/api-docs`，這點和 nginx 的字串前綴不同。

Flask 的路由本來就帶 `/api`（原本的 `proxy_pass http://backend;` 沒有 URI 部分，路徑原樣轉送），這份 HTTPRoute 也原樣轉送，不需要改寫。

最常見的兩個錯誤：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 換成 Gateway 分流後，偶發 503：`upstream connect error or disconnect/reset before headers. reset reason: connection termination` | Gateway 對後端的閒置逾時（Envoy 預設 1 小時）比 gunicorn 的 keep-alive 長 | 調短 Gateway 的上游閒置逾時，讓它比 gunicorn 的短 |
| 分流後所有 API 都 404 | 後端的路由有 `/api`，Gateway 卻去掉了前綴；或反過來 | 對照後端的路由決定要不要 `ReplacePrefixMatch`，用後面的模擬確認 |

:::stop 讀到這裡可以先停：會比較兩條路，用 HTTPRoute 把 `/api` 分到後端。完成條件：`/api/board` 由後端回應、`/api-docs/` 回到前端，直接連後端的那一層閒置逾時比後端的 keep-alive 短。後面的第一條路、去掉前綴、Ingress 與 keep-alive 的細節，在保留 nginx 當入口、後端路由沒有 `/api` 前綴或出現偶發 502、503 時再回來讀。

## 第一條路：保留 nginx 當入口

nginx 的設定要改三個地方：

```nginx
upstream backend {
    server clinic-api:9696;          # 原本是 backend:9696；同一個 namespace 用短名稱就解析得到
    keepalive 16;
    keepalive_timeout 60s;           # 照舊：比 gunicorn 的 --keep-alive 75 短
}

server {
    listen 8080;                     # unprivileged 映像
    root /usr/share/nginx/html;
    # ...index.html、/assets/、/config.js、/ 照前兩課...

    location /api/ {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;   # TLS 在 Gateway 終止，$scheme 會是 http
    }
}
```

- **主機名稱換成 Service**：nginx 在啟動時用系統的 resolver 解析 `clinic-api`，`/etc/resolv.conf` 的搜尋網域會補成 `clinic-api.clinic.svc.cluster.local`，得到 Service 的 ClusterIP。ClusterIP 不會因為後端 Pod 重建而變，[nginx 那一課](#/skill/nginx) 講的「後端容器換了 IP、nginx 還連舊的」在這裡不會發生。啟動時 Service 還不存在，nginx 一樣起不來（`host not found in upstream`），Pod 會進入 CrashLoopBackOff，直到 Service 建好。改用 `resolver` 加變數做執行時解析的話，nginx 自己的 resolver 不套用搜尋網域，要寫完整名稱。
- **`X-Forwarded-Proto`**：原本 nginx 自己終止 TLS，`$scheme` 是 https；現在 TLS 在 Gateway，nginx 收到的是 http，要把 Gateway 帶來的值轉下去，否則 Flask 會以為請求是 http，產生錯的轉址網址。客戶端 IP 也一樣：`$remote_addr` 變成 Gateway 代理 Pod 的 IP，要記錄真實 IP 得用 realip 模組信任 Gateway 的位址，信任邊界的畫法見 [負載平衡](#/skill/load-balancing)。
- **`location /api/` 加上結尾斜線**：原本的 `/api` 也會比對到 `/api-docs`、`/apiary`，這些路徑會被送到後端。

Gateway 這一層只有一條規則，整個 hostname 都給 nginx。實作路線的 HTTPRoute 把 `clinic.example` 整個給了 `clinic-api`（那時還沒有前端），加上前端之後換成這份：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: clinic
  namespace: clinic
spec:
  parentRefs:
    - name: clinic-gateway             # 實作路線的 Gateway
  hostnames: ["clinic.example"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: clinic-web
          port: 80
```

## 第二條路的細節：去掉前綴、Ingress、NetworkPolicy

如果原本寫的是 `proxy_pass http://backend:9696/;`、後端路由沒有 `/api`，就要在 Gateway 這層去掉前綴：

```yaml
    - matches:
        - path: { type: PathPrefix, value: /api }
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /       # /api/patients → /patients
      backendRefs:
        - name: clinic-api
          port: 9696
```

去掉前綴的寫法依入口元件而不同：

| 入口 | 怎麼去掉 `/api` |
|---|---|
| Gateway API 的 HTTPRoute | `URLRewrite` filter 的 `ReplacePrefixMatch`。它屬於 Extended 支援等級，實作可以不支援；用 `kubectl describe httproute` 看 status 有沒有被接受 |
| Ingress（API 本身） | 沒有改寫的欄位，只能靠各 controller 自己的 annotation 或 CRD |
| ingress-nginx | `nginx.ingress.kubernetes.io/rewrite-target` 搭配 regex 路徑；這個專案已在 2026 年 3 月停止維護，新的建置不要再選 |
| 其他 Ingress controller | 各自的 annotation 或 middleware，以文件為準 |

叢集還在用 Ingress 的話，不改寫的分流寫成這樣，可以在不同 controller 之間搬（`pathType: Prefix` 一樣是一段一段比）：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: clinic
  namespace: clinic
spec:
  ingressClassName: example-class      # 換成叢集實際的 IngressClass
  rules:
    - host: clinic.example
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend: { service: { name: clinic-api, port: { number: 9696 } } }
          - path: /
            pathType: Prefix
            backend: { service: { name: clinic-web, port: { number: 80 } } }
```

第二條路的 `/api` 由 Gateway 的代理 Pod 直接連到 `clinic-api`，不再經過 `clinic-web`。照 [Kubernetes NetworkPolicy](#/skill/k8s-network-policy) 寫好的 NetworkPolicy 只放行 web 到 api，要再加一條：`from` 寫代理 Pod 所在的 namespace（Envoy Gateway 預設是 `envoy-gateway-system`，依安裝方式而定）。

## keep-alive：換了前面那一層，規則不變

原本把 gunicorn 的 `--keep-alive` 設得比 nginx upstream 的 `keepalive_timeout` 長，是為了讓 nginx 先關掉閒置連線。反過來的話，gunicorn 先關，nginx 剛好拿那條已經被關掉的連線送下一個請求，就會失敗。換到 K8s 之後，這條規則不變，要檢查的是「現在直接連 gunicorn 的是誰」：

| 前面那一層 | 對後端閒置連線的逾時 | 預設 |
|---|---|---|
| nginx（第一條路） | upstream 的 `keepalive_timeout`（1.15.3 起） | 60 秒 |
| Envoy Gateway（第二條路；實作路線用的實作） | BackendTrafficPolicy 的 `timeout.http.connectionIdleTimeout` | 1 小時 |
| 其他 Gateway 或 Ingress 實作 | 各自的設定 | 以文件為準 |

第一條路中間多了 Service，但 kube-proxy 做的是連線層級的轉送，nginx 的一條 keepalive 連線從頭到尾對到同一個 Pod，規則照舊。第二條路換成 Envoy，預設的 1 小時比 gunicorn 的 75 秒長得多，要把它調短：

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: clinic-upstream
  namespace: clinic
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: clinic
  timeout:
    http:
      connectionIdleTimeout: 60s       # 比 gunicorn 的 --keep-alive 75 短
```

欄位名稱依 Envoy Gateway 的版本而定，以它的文件為準。另外兩件事：gunicorn 的 `--keep-alive` 預設只有 2 秒；sync worker 不支援持久連線、會忽略這個選項，每個回應後都關閉連線，所以這條規則在 gthread、gevent 這類 worker 上才有意義。連線層級的分配也代表後端擴容之後，新 Pod 要等前面那一層開新連線才分得到流量。

## 模擬：請求送到哪個 Service、後端收到什麼路徑

```python run
# 路徑分流：外面那一層（HTTPRoute）先選規則，再看 nginx 或 Flask 收到什麼路徑
def segments(path):
    return [s for s in path.split("?")[0].split("/") if s]

def path_prefix(prefix, path):         # Gateway API 的 PathPrefix 與 Ingress 的 Prefix：一段一段比
    p = segments(prefix)
    return segments(path)[:len(p)] == p

def replace_prefix(path, prefix, repl):   # URLRewrite 的 ReplacePrefixMatch
    route, _, query = path.partition("?")
    rest = route[len(prefix.rstrip("/")):]   # 比對到的前綴後面剩下的部分
    new = repl.rstrip("/") + rest or "/"
    return new + ("?" + query if query else "")

def gateway(rules, path):
    # 優先序：Exact 先，再來是字元數最多的 PathPrefix
    hits = [r for r in rules if (r["type"] == "Exact" and path.split("?")[0] == r["value"])
            or (r["type"] == "PathPrefix" and path_prefix(r["value"], path))]
    if not hits:
        return None, path
    best = max(hits, key=lambda r: (r["type"] == "Exact", len(r["value"])))
    sent = replace_prefix(path, best["value"], best["rewrite"]) if "rewrite" in best else path
    return best["backend"], sent

FLASK = {"/api/patients", "/api/health"}          # 後端的路由本來就有 /api 前綴
DIST = {"/index.html", "/assets/index-3f9c2a1b.js"}

def nginx(path, api_location):        # 第一條路的 nginx：location 用字串前綴比對
    if api_location and path.startswith(api_location):
        return "clinic-api", path       # proxy_pass 沒寫 URI 部分：路徑原樣轉送
    return "web", path

def finish(service, path):
    route = path.split("?")[0]
    if service == "clinic-api":
        return "Flask 200" if route in FLASK else "Flask 404"
    return f"送出 {route}" if route in DIST else "送出 /index.html（SPA）"

KEEP = [{"type": "PathPrefix", "value": "/", "backend": "clinic-web"}]
SPLIT = [{"type": "PathPrefix", "value": "/api", "backend": "clinic-api"},
         {"type": "PathPrefix", "value": "/", "backend": "clinic-web"}]
STRIP = [{"type": "PathPrefix", "value": "/api", "backend": "clinic-api", "rewrite": "/"},
         {"type": "PathPrefix", "value": "/", "backend": "clinic-web"}]

scenarios = [
    ("第一條路：HTTPRoute 全給 nginx，nginx 用 location /api/", KEEP, "/api/"),
    ("第一條路，但 nginx 沿用原本的 location /api（沒有結尾斜線）", KEEP, "/api"),
    ("第二條路：HTTPRoute 依路徑分流，不改寫", SPLIT, None),
    ("第二條路，/api 規則加上 ReplacePrefixMatch: /", STRIP, None),
]
requests = ["/patients/123", "/assets/index-3f9c2a1b.js", "/api/patients?page=2", "/api", "/api-docs/"]

for title, rules, api_location in scenarios:
    print(title)
    for req in requests:
        svc, sent = gateway(rules, req)
        hops = svc
        if svc == "clinic-web":
            svc, sent = nginx(sent, api_location)
            hops += " → clinic-api" if svc == "clinic-api" else ""
        print(f"  {req:<26} {hops} 收到 {sent}：{finish(svc, sent)}")
    print()
```

第二組是沿用原本 `location /api` 的結果：`/api-docs/` 被送到 Flask、回 404，同一個請求在第一組與第三組都回到前端。第四組是對一個路由本來就有 `/api` 的後端多做了改寫，每個 API 都 404。

## 雲端代管的差異

| 項目 | 地端自建 | 雲端代管 |
|---|---|---|
| 入口 | Gateway 或 Ingress 的實作，對外靠 MetalLB 或院內的負載平衡設備（見 [Kubernetes 網路](#/skill/k8s-networking)） | controller 自動建立雲端的負載平衡器 |
| 閒置逾時 | 自己設定的那一層代理 | 雲端負載平衡器也有自己的閒置逾時（例如 AWS ALB 預設 60 秒），規則一樣：要比 gunicorn 的 keep-alive 短 |

## 常見錯誤與錯誤訊息

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `[emerg] host not found in upstream "clinic-api:9696"`，Pod CrashLoopBackOff | 第一條路的 nginx 啟動時解析不到 Service：還沒建立、名稱打錯、不在同一個 namespace | 先建 Service；跨 namespace 寫 `clinic-api.<namespace>` |
| Flask 產生的轉址變成 `http://`，或登入後被導回 http | 第一條路的 nginx 送 `X-Forwarded-Proto $scheme`，TLS 已經在 Gateway 終止 | 改成轉送 `$http_x_forwarded_proto` |
| `/api-docs/` 這類路徑被送到後端、回 404 | 第一條路的 nginx 沿用沒有結尾斜線的 `location /api`，字串前綴也比對到 `/api-docs`、`/apiary` | 改成 `location /api/` |
| 第二條路的 `/api` 到不了後端 | NetworkPolicy 只放行 web 到 api，`/api` 現在由 Gateway 的代理 Pod 直接連 `clinic-api` | 加一條規則，`from` 寫代理 Pod 所在的 namespace |

## 動手

1. 執行分流那段模擬，把 `FLASK` 改成 `{"/patients", "/health"}`（後端路由沒有 `/api` 前綴），看第三組與第四組的結果怎麼對調。
2. 做本課的程式題：實作 HTTPRoute 的規則選擇與前綴改寫，算出後端收到的路徑。
3. 在本機叢集上做（建叢集與安裝 Gateway API 實作的方式見 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）：`clinic-web` 照 [前端的執行期設定](#/skill/spa-runtime-config) 的「動手」部署好，再套用第二條路的 HTTPRoute。本機的 `clinic-api` 是實作路線那一份：業務路由和 Flask 一樣本來就在 `/api` 底下（健康檢查 `/healthz` 不在）、Service 是 80，所以 `/api` 那條規則原樣轉送、port 改成 80。用 `curl -H 'Host: clinic.example' http://<Gateway 的位址>/api/board` 確認由 `clinic-api` 回應（不用登入的看板 JSON）、`/api-docs/` 回到前端；再替 `/api` 那條規則加上 `ReplacePrefixMatch: /`，看 `/api/board` 變成 404：後端收到的是 `/board`。
