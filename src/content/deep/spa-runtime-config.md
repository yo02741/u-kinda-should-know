## 測試過的映像推到正式環境，前端還是導向測試的 SSO

接在 [前端與 nginx 上 K8s](#/skill/spa-containers) 之後：那一課把 dist 打包成只送靜態檔的映像，這一課讓同一個映像跑在不同環境、部署到叢集。

前端程式裡常見這種寫法：

```js
// src/auth.js
const SSO_URL = import.meta.env.VITE_SSO_URL
```

Vite 只把 `VITE_` 開頭的變數暴露給前端程式，而且在 `npm run build` 時把 `import.meta.env.VITE_SSO_URL` **直接換成字串**寫進 bundle：

```bash
$ VITE_SSO_URL=https://sso-test.example/authorize npm run build
$ grep -o 'https://sso[^"]*' dist/assets/index-*.js
https://sso-test.example/authorize
```

這個值在映像建好的那一刻就固定了。測試環境驗證過的映像推到正式環境，前端還是導向測試的 SSO；要改，只能用正式環境的值重建一次，於是「正式環境跑的映像」不再是「測試過的那一個」。

## 執行期設定：環境之間不同的值由 nginx 送 `/config.js`

執行期設定的做法：環境之間不同的值不進 bundle，由 nginx 送一個 `/config.js`，前端啟動時讀它。

```html
<!-- index.html：放在 module script 前面。一般的 script 會同步執行，main.js 跑的時候設定已經在了 -->
<script src="/config.js"></script>
<script type="module" src="/src/main.js"></script>
```

```js
// public/config.js：開發時用的預設值。Vite 會原樣複製到 dist/config.js
window.__CLINIC_CONFIG__ = {
  envName: "開發",
  ssoUrl: "http://localhost:5174/authorize",
  apiBase: "/api",
}
```

```js
// src/runtime-config.js：程式裡只從這裡拿設定
const cfg = window.__CLINIC_CONFIG__ || {}
export const ENV_NAME = cfg.envName || "開發"
export const SSO_URL = cfg.ssoUrl
export const API_BASE = cfg.apiBase || "/api"
```

在 K8s 上，`config.js` 的內容放在 ConfigMap，每個環境一份，以目錄的形式掛進 nginx 容器，nginx 從那裡送出：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: clinic-web-config
  namespace: clinic
data:
  config.js: |
    window.__CLINIC_CONFIG__ = {
      envName: "正式",
      ssoUrl: "https://sso.example/authorize",
      apiBase: "/api",
    };
```

```nginx
location = /config.js {
    alias /etc/clinic-web/config.js;            # ConfigMap 掛在 /etc/clinic-web/（Deployment 在下一章）
    add_header Cache-Control "no-cache" always;
}
```

掛成整個目錄、不用 `subPath`，ConfigMap 更新後檔案內容過一段時間會跟著換，nginx 下一次送出新內容，不必重建映像也不必重啟 Pod；已經開著的頁面要重新整理才讀得到。用 `subPath` 把單一檔案掛進 `/usr/share/nginx/html/` 的寫法不會更新，見 [Kubernetes 實作：設定、探針與資源](#/skill/k8s-config-probes)。

`config.js` 是公開檔案，任何打開網頁的人都讀得到，它跟 bundle 一樣不能放秘密：資料庫密碼、API 金鑰、OAuth 的 client secret 都不行。前端需要呼叫的外部服務，由後端代為呼叫，秘密留在後端，見 [秘密管理](#/skill/secrets)。

## 部署到叢集：Deployment 掛 ConfigMap

`clinic-web` 的 Deployment 與 Service。`/api` 由誰轉給後端有兩條路（見 [前端與 API 的路徑分流](#/skill/spa-api-routing)），這一份兩條路都一樣：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clinic-web
  namespace: clinic
spec:
  replicas: 2
  selector:
    matchLabels:
      app: clinic-web
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: clinic-web
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 101                 # nginx-unprivileged 的 UID
      containers:
        - name: web
          image: registry.gitlab.example/clinic/web:3f9c2a1b
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:              # 只看 nginx 自己送得出靜態檔，不打 /api
            httpGet: { path: /index.html, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /index.html, port: http }
            periodSeconds: 10
          resources:                   # 示意值
            requests: { cpu: 50m, memory: 32Mi }
            limits: { memory: 128Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - name: runtime-config
              mountPath: /etc/clinic-web
              readOnly: true
            - name: tmp                # pid 檔與暫存檔在 /tmp
              mountPath: /tmp
      volumes:
        - name: runtime-config
          configMap:
            name: clinic-web-config
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: clinic-web
  namespace: clinic
spec:
  selector:
    app: clinic-web
  ports:
    - name: http
      port: 80
      targetPort: http
```

最常見的兩個錯誤：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 改了 ConfigMap，`/config.js` 一直是舊內容 | 用 `subPath` 掛單一檔案，或值是透過環境變數產生的 | 掛整個目錄；用 templates 的話 `kubectl rollout restart` |
| Pod 被 OOMKilled | nginx 的 `worker_processes auto` 依節點看得到的 CPU 數開 worker，不看 Pod 的 CPU limit；在 32 核的節點上會開出 32 個 worker，記憶體 limit 抓太緊就會被 OOMKilled | 在映像裡帶自己的 `nginx.conf` 把它寫成固定的數字（例如 2），比較好估 |

:::stop 讀到這裡可以先停：會把環境之間不同的值移到 `/config.js`，用 ConfigMap 掛進前端的 Deployment。完成條件：兩個環境的映像 digest 相同、`/config.js` 內容不同，`grep` `dist/` 找不到任何一個環境的網址。後面的 templates、健康檢查、子路徑部署與 chunk 404，在值要從環境變數來、部署到子路徑或滾動更新後出現 404 時再回來讀。

## 另一種做法：templates 加環境變數

官方 nginx 映像（1.19 起，unprivileged 版也有）有 templates 機制：容器啟動時，`/etc/nginx/templates/*.template` 會經過 `envsubst` 產生到 `/etc/nginx/conf.d/`，值來自環境變數，環境變數再由 ConfigMap 的 `envFrom` 注入：

```nginx
# /etc/nginx/templates/default.conf.template（啟動時產生 /etc/nginx/conf.d/default.conf）
location = /config.js {
    default_type application/javascript;
    add_header Cache-Control "no-cache" always;
    return 200 'window.__CLINIC_CONFIG__ = { envName: "${CLINIC_ENV_NAME}", ssoUrl: "${CLINIC_SSO_URL}", apiBase: "/api" };';
}
```

映像的啟動腳本只替換**目前有定義的**環境變數，所以同一個檔案裡的 `$uri`、`$host` 這些 nginx 變數不受影響（除非剛好有同名的環境變數；`NGINX_ENVSUBST_FILTER` 可以限定只替換符合樣式的名稱）。

| | ConfigMap 掛成檔案 | templates 加環境變數 |
|---|---|---|
| 改值之後 | 檔案自動更新，nginx 不用重啟 | 環境變數只在啟動時讀，要 `kubectl rollout restart` |
| 漏了一個值 | 前端讀到 `undefined`，要靠程式檢查 | 沒被替換的 `${CLINIC_SSO_URL}` 留在設定裡，nginx 會把它當成未知變數、啟動失敗 |
| 根檔案系統唯讀 | 沒影響 | 產生設定的輸出目錄要可寫，要另外掛 emptyDir |
| 適合 | 值比較多、要整段 JS | 只有幾個值，想在啟動時就擋下漏設定 |

## 前端的健康檢查

nginx 的探針打靜態檔就夠了。打 `/index.html` 同時確認了 nginx 在跑、dist 確實在映像裡（dist 漏了會回 404，Pod 不會變成 ready）。保留 nginx 當入口、由它轉發 `/api` 時（[前端與 API 的路徑分流](#/skill/spa-api-routing) 的第一條路），不要讓探針打 `/api/...`：後端一停，所有前端 Pod 都會被移出 Service，使用者連「系統維護中」的頁面都看不到，而且後端恢復前，滾動更新也會卡住。探針每幾秒打一次，access log 會很吵，可以在 nginx 用 `map` 依 User-Agent（`kube-probe/…`）關掉這些請求的 log。

## 子路徑部署

系統要掛在 `https://portal.example/clinic/` 底下時，三個地方要對同一個前綴：

| 位置 | 設定 | 對不上的現象 |
|---|---|---|
| Vite | `base: '/clinic/'`；Vue Router 用 `createWebHistory(import.meta.env.BASE_URL)` | index.html 引用 `/assets/…`，被 Gateway 送去別的服務或 404 |
| nginx | dist 複製到 `/usr/share/nginx/html/clinic/`，location 改成 `/clinic/`、`/clinic/assets/`，fallback 改成 `/clinic/index.html` | 深層連結重新整理回 404，或拿到別的系統的首頁 |
| HTTPRoute 或 Ingress | `PathPrefix /clinic` 到 `clinic-web`，不改寫 | 前綴被去掉，nginx 收到的路徑和目錄對不上 |

建議整條路都不改寫路徑：瀏覽器、Gateway、nginx 看到的都是 `/clinic/…`，在本機用 port-forward 直接連 nginx 測試時，網址也和正式環境一樣。手寫在 index.html、不經過 Vite 打包的路徑（例如 `config.js` 的 script）要自己帶上前綴，建置後打開 `dist/index.html` 檢查一次。API 若放在 `/clinic/api`，HTTPRoute 那條規則用 `ReplacePrefixMatch: /api` 換回 Flask 認得的路徑。改寫的寫法見 [前端與 API 的路徑分流](#/skill/spa-api-routing)。

## 滾動更新時的 chunk 404

Vite 把每個路由頁面拆成獨立的 chunk，點到才載入。滾動更新之後會出現這種事：

| 時間 | 事件 |
|---|---|
| 09:00 | 櫃台開著 v1 的掛號頁，已經載入 `index-3f9c2a1b.js`，還沒點過「批價」 |
| 09:05 | 部署 v2，滾動更新完成，每個 Pod 的映像裡只有 v2 的 assets |
| 09:20 | 點「批價」，瀏覽器要 v1 的 `/assets/Billing-77aa1c2e.js`，回 404，頁面卡住 |

滾動更新進行中還有另一個方向：瀏覽器從新 Pod 拿到 v2 的 `index.html`，接著要 v2 的 assets，這個請求被分到還沒換掉的舊 Pod，一樣 404。瀏覽器的 console 會出現類似 `Failed to fetch dynamically imported module: https://clinic.example/assets/Billing-77aa1c2e.js` 的錯誤（文字依瀏覽器而異）。原本的設定把找不到的 assets 換成 `index.html`，錯誤會變成 `Expected a JavaScript module script but the server responded with a MIME type of "text/html"` 這類訊息，更難聯想到是版本問題。

| 做法 | 處理到的情況 | 代價 |
|---|---|---|
| 接受重新整理：前端監聽 `vite:preloadError`，載入失敗就 `location.reload()` | 兩個方向都能恢復，重新整理後拿到新版 | 使用者填到一半的表單會不見；掛號、批價這類表單要先存草稿 |
| 映像裡保留上一版的 assets（建置時從上一版的映像複製 `assets/`） | 舊頁面要舊 chunk | 映像變大；滾動更新期間新頁面打到舊 Pod 仍會 404 |
| assets 放到所有 Pod 共用、只增不刪的位置（例如物件儲存），部署前先上傳，定期清掉幾版以前的 | 兩個方向都處理 | 多一套儲存與清理排程，見 [物件儲存](#/skill/object-storage) |

院內系統的部署多半排在離峰時段，第一種做法加上表單草稿通常就夠了。不管選哪一種，`index.html` 都要是 `no-cache`，否則瀏覽器會一直拿著舊的 `index.html` 去要舊的 chunk。

## 雲端代管的差異

| 項目 | 地端自建 | 雲端代管 |
|---|---|---|
| 靜態檔 | nginx 容器 | 也常直接放物件儲存加 CDN，不跑 nginx 容器；`/api` 由 CDN 或負載平衡器依路徑分流 |
| chunk 404 | 要自己選上面的做法 | assets 放在物件儲存時舊檔通常還在，問題少很多 |

## 常見錯誤與錯誤訊息

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 測試過的映像推到正式環境，使用者被導到測試的 SSO | 網址用 `VITE_` 變數，在 `npm run build` 時寫進了 bundle | 改放 `/config.js`，每個環境一份 ConfigMap |
| 用 templates 的 Pod 啟動失敗 | 漏了一個環境變數，沒被替換的 `${CLINIC_SSO_URL}` 留在設定裡，nginx 把它當成未知變數 | 補上那個環境變數（ConfigMap 的 `envFrom`） |
| 前端的 Pod 一直沒有變成 ready | dist 沒進映像，探針打 `/index.html` 回 404 | 檢查 Dockerfile 的 `COPY --from=build` 與 `root` |
| 後端一停，前端也整個打不開 | 探針打了 `/api/...`，所有前端 Pod 被移出 Service | 探針只打靜態檔 |
| 子路徑部署後，深層連結重新整理回 404，或拿到別的系統的首頁 | nginx 的目錄、location、fallback 沒有和 Vite 的 `base` 對到同一個前綴 | 照「子路徑部署」那張表，三個地方用同一個前綴 |
| 部署後點某些頁面沒反應，console 有 `Failed to fetch dynamically imported module` | 舊頁面要的 chunk 已經不在 | 見「滾動更新時的 chunk 404」的三種做法 |

## 動手

1. 在本機叢集上做（建叢集的方式見 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）：用 [前端與 nginx 上 K8s](#/skill/spa-containers) 那份 `default.conf` 建好前端映像，拿掉 `location /api/` 讓它只送靜態檔（nginx 啟動時不必解析 `clinic-api`），`kind load docker-image` 載進叢集，套用本課的 ConfigMap、Deployment 與 Service，然後：

```bash
kubectl port-forward -n clinic service/clinic-web 8080:80
curl -sI http://localhost:8080/patients/123 | grep -i cache-control
# 預期：Cache-Control: no-cache
curl -sI http://localhost:8080/assets/<dist 裡的某個檔名> | grep -i cache-control
# 預期：Cache-Control: public, max-age=31536000, immutable
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/assets/not-exist.js
# 預期：404
kubectl edit configmap clinic-web-config -n clinic      # 改 envName
curl -s http://localhost:8080/config.js                 # 過一陣子再執行，內容會變，Pod 沒有重啟
```

2. 再建一個 namespace，套用同一份 Deployment 與另一份 ConfigMap（`envName`、`ssoUrl` 換成另一個環境的值）。確認兩邊的映像 digest 相同、`/config.js` 內容不同，並在前端專案 `grep` `dist/`，確認找不到任何一個環境的網址。
3. 做設計情境 [多環境的設定放哪裡](#/scenario/env-config-choice)，比較 `VITE_` 變數、`config.js` 與伺服器寫進 `index.html` 三種做法。

接下來：要把 `/api` 搬上 Kubernetes 時讀 [前端與 API 的路徑分流](#/skill/spa-api-routing)。
