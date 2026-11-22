// 領域內文（d6-deploy，p3 批）：以技能 id 為 key，由 body/d6-deploy.js 合併。只放這些技能：spa-containers、spa-runtime-config、spa-api-routing
export default {
  'spa-containers': {
    map: {
      names: [
        { n: '多階段建置', t: 'node 階段 `npm ci`、`npm run build`，nginx 階段只 `COPY --from=build /app/dist` 到 `root` 指向的目錄；最終映像只有 nginx 與靜態檔，tag 對應前端版本。' },
        { n: '`nginx/nginx-unprivileged`', t: 'NGINX 官方維護的非 root 變體，預設聽 8080、以 UID 101 執行；沿用 `listen 80;` 在不允許非 root 綁低 port 的環境會啟動失敗，Service 的 `targetPort` 也要跟著改。' },
        { n: '`/version.json`', t: '建置時把 commit SHA 寫進 `dist/version.json`，`curl /version.json` 就知道跑的是哪一版前端；映像的 tag 也用 commit SHA。' },
        { n: 'SPA fallback', t: '`try_files $uri $uri/ /index.html`：找不到檔案的路徑（`/patients/123`）交給前端路由。這是內部轉址，回應帶的是 `location = /index.html` 的標頭。' },
        { n: 'index.html 與帶 hash 的 assets', t: '`index.html` 檔名固定，用 `no-cache` 每次驗證；`/assets/` 的檔名帶內容 hash，給 `public, max-age=31536000, immutable`，找不到回 404。' },
        { n: '`add_header` 繼承', t: '一個 location 只要寫了 `add_header`，上一層的就全部不算；共用的安全標頭要每層重寫、用 `include`，或 1.29.3 起的 `add_header_inherit merge`。' },
      ],
      ask: [
        'dist 在建置時打包進映像、tag 用 commit SHA，以及怎麼查正式環境跑的是哪一版（例如 `/version.json`）。',
        '`index.html`、`/assets/`、SPA fallback 各自的 `Cache-Control`，以及每個回應都要帶的安全標頭。',
        '`/assets/` 底下找不到的檔案回 404，不走 SPA fallback。',
        '以非 root 執行時聽哪個 port，dist 複製到哪個目錄（和 `root` 相同）。',
      ],
      prompt: '門診掛號的前端（Vue 3 + Vite）用多階段 Dockerfile 建成映像：build 階段 `npm ci`、`npm run build`，並把 commit SHA 寫進 `dist/version.json`；runtime 用 `nginx/nginx-unprivileged` 聽 8080，tag 用 commit SHA。nginx 的 `location = /index.html` 給 `no-cache`，`/assets/` 給 `public, max-age=31536000, immutable` 並 `try_files $uri =404`，其他路徑走 SPA fallback；有自己 `add_header` 的 location 都要再寫一次 `X-Content-Type-Options: nosniff`。',
      verify: [
        { c: '快取標頭', t: '`curl -sI` 打 `/patients/123`、`/assets/<某個檔名>`，`Cache-Control` 應該依序是 `no-cache`、`public, max-age=31536000, immutable`；`/assets/not-exist.js` 要回 404，回 200 加 HTML 代表 fallback 套到了 assets。' },
        { c: '第二次開頁', t: '開發者工具 Network 分頁（不勾 Disable cache）重新整理，assets 要顯示 `(disk cache)` 或 `(memory cache)`、`index.html` 回 304；每次整包重新下載，代表 `no-store` 套到了 `/assets/`。' },
        { c: '少了的標頭', t: '對 `/`、`/assets/` 底下的檔案各打一次 `curl -sI`，確認 server 層設的 `X-Content-Type-Options` 都在；少了的那個 location 自己寫了 `add_header`。' },
        { c: 'dist 的位置', t: '打開網站是 nginx 的歡迎頁或 403，代表 `COPY --from=build` 的目的地和 `default.conf` 的 `root` 不一致。' },
        { c: '啟動失敗', t: '容器的 log 有 `bind() to 0.0.0.0:80 failed (13: Permission denied)`，代表以非 root 執行卻沿用 `listen 80;`；改聽 8080。' },
      ],
    },
    points: [
      { b: 'nginx 是整個系統的入口', t: '`/` 自己送 Vue 建置出的靜態檔，`/api` 轉給後端（gunicorn）。前一半跟著前端改（dist、快取規則），後一半跟著後端改（路徑、逾時、轉發標頭）。搬上 K8s 時要決定這兩個角色要不要拆開。' },
      { b: 'dist 在建置時打包進映像', t: '多階段 Dockerfile：node 階段先複製 `package.json` 與 lock 檔再 `npm ci`，接著 `npm run build`；nginx 階段只 `COPY --from=build /app/dist` 到和 `root` 相同的目錄。映像的 tag 對應前端版本，回滾換 tag。`.dockerignore` 排除 `node_modules` 與 `dist`。' },
      { b: '以非 root 執行', t: '用 `nginx/nginx-unprivileged`：預設聽 8080、以 UID 101 執行，pid 檔與暫存目錄改到 `/tmp`。把 `listen 80;` 的設定直接搬過去，在不允許非 root 綁低 port 的環境會啟動失敗。' },
      { b: 'index.html 每次驗證，帶 hash 的 assets 存一年', t: '`location = /index.html` 給 `no-cache`（SPA fallback 是內部轉址，也會落到這裡），`/assets/` 給 `public, max-age=31536000, immutable` 並 `try_files $uri =404`。' },
      { b: '`add_header` 不會逐層累加', t: '一個 location 只要寫了 `add_header`，就不再繼承上一層的 `add_header`；共用的標頭每層重寫、用 include，或 1.29.3 起的 `add_header_inherit merge`。沒有加 `always` 的 `add_header` 不會出現在 404 與 5xx 的回應上。' },
    ],
    checklist: [
      '能寫出前端的多階段 Dockerfile 與 .dockerignore，並說明怎麼從映像的 tag 與 /version.json 查出正式環境跑的是哪一版前端',
      '能寫出 index.html、/assets/ 與 SPA fallback 分開快取的 nginx 設定，並指出哪些 location 會因為自己有 add_header 而少了 server 層的標頭',
      '能說明 /patients/123 這種深層連結的回應為什麼帶 location = /index.html 的標頭，以及 /assets/ 底下找不到的檔案為什麼要回 404',
    ],
    challenge: {
      task: '先做本課的兩題程式題，再用多階段 Dockerfile 建出自己前端專案的映像（`nginx/nginx-unprivileged`，tag 用 commit SHA），在本機把容器跑起來，驗收 `index.html`、`/assets/` 與 SPA fallback 的快取標頭。執行前先寫下每個網址預期的狀態碼與 `Cache-Control`。',
      deliver: '一份可以重跑的驗收腳本（`curl` 指令加預期輸出），以及一次實際執行的結果',
      check: [
        '`/patients/123`、`/assets/<檔名>`、`/assets/not-exist.js` 分別得到 `no-cache`、`immutable` 與 404',
        '`/version.json` 的 commit 和映像的 tag 相同',
        '`/`、`/assets/<檔名>` 的回應都帶 `X-Content-Type-Options: nosniff`',
        '預測在執行前寫下，和結果並排',
      ],
      twist: '業務要求前端改放在子路徑 `/portal/`。先預測驗收腳本要改哪幾行、映像要不要重建。',
    },
    refs: [
      { label: 'nginx：ngx_http_headers_module（add_header）', url: 'https://nginx.org/en/docs/http/ngx_http_headers_module.html' },
      { label: 'Docker Hub：nginx 官方映像（非 root 執行）', url: 'https://hub.docker.com/_/nginx' },
    ],
  },
  'spa-runtime-config': {
    map: {
      names: [
        { n: '建置時設定（`VITE_`）', t: '`VITE_` 開頭的變數在 `npm run build` 時被換成字串寫進 bundle；映像建好值就固定，換環境要重建。' },
        { n: '執行期設定（`/config.js`）', t: '環境之間不同的值不進 bundle，由 nginx 送 `/config.js`，前端啟動時讀它。誰都讀得到，不放秘密。' },
        { n: 'ConfigMap 掛成目錄', t: '每個環境一份 ConfigMap，以目錄掛進 nginx 容器；改了之後檔案過一段時間自動更新，不必重啟 Pod。用 `subPath` 掛的單一檔案不會更新。' },
        { n: 'templates（envsubst）', t: '官方 nginx 映像啟動時把 `/etc/nginx/templates/*.template` 用環境變數產生成設定；值只在啟動時讀，漏了變數 nginx 會啟動失敗。' },
        { n: '唯讀根檔案系統', t: '`readOnlyRootFilesystem: true` 時，nginx 的 pid 檔與暫存檔所在的 `/tmp` 要另外掛 emptyDir。' },
        { n: '子路徑部署', t: 'Vite 的 `base`、nginx 的目錄與 location、HTTPRoute 的前綴，三個地方對同一個前綴，整條路不改寫路徑。' },
        { n: 'chunk 404（`vite:preloadError`）', t: '滾動更新後，舊頁面要的 chunk 已經不在，或新頁面的請求打到舊 Pod；前端監聽 `vite:preloadError` 重新載入，或讓舊的 assets 留著。' },
      ],
      ask: [
        '哪些值每個環境不同（SSO 網址、環境名稱），放執行期設定，不用 `VITE_` 變數。',
        '`/config.js` 的內容從哪裡來：ConfigMap 掛成目錄，還是 templates 加環境變數；改值之後要不要重啟 Pod。',
        '`/config.js` 的 `Cache-Control`（`no-cache`），以及它是公開檔案、不放秘密。',
        '探針打哪個路徑：靜態檔（`/index.html`），不打 `/api`。',
        '部署後舊頁面載入不到 chunk 時怎麼處理：重新載入、保留上一版的 assets，或放到共用的儲存。',
      ],
      prompt: '門診掛號前端的 SSO 網址與環境名稱不用 `VITE_` 變數：`index.html` 在 module script 前面載入 `/config.js`，內容放在每個環境各一份的 ConfigMap，以目錄掛到 `/etc/clinic-web`（不用 `subPath`），nginx 用 `alias` 送出並給 `no-cache`。Deployment 以 UID 101 執行、根檔案系統唯讀，`/tmp` 掛 emptyDir；readiness 與 liveness 都打 `/index.html`。前端監聽 `vite:preloadError`，載入不到 chunk 時重新載入。',
      verify: [
        { c: '設定沒寫進 bundle', t: '`grep -o \'https://sso[^"]*\' dist/assets/*.js` 不該找到網址；改 ConfigMap 後過一陣子 `curl /config.js` 內容要跟著變，不必重建映像。用 `subPath` 掛的檔案不會更新。' },
        { c: '同一個映像', t: '兩個環境的映像 digest 要相同，`/config.js` 的內容不同；digest 不同代表某個環境重建過。' },
        { c: '快取', t: '`curl -sI` 打 `/config.js`，`Cache-Control` 要是 `no-cache`；被長效快取的話，改了值瀏覽器還拿著舊的。' },
        { c: '探針', t: '後端停掉時前端的 Pod 仍然是 ready；全部被移出 Service 代表探針打了 `/api`。' },
        { c: '部署後的舊頁面', t: '部署新版後，在還開著舊版的頁面點沒載入過的路由；console 出現 `Failed to fetch dynamically imported module` 之後頁面要自己重新載入，卡住代表沒處理。' },
      ],
    },
    points: [
      { b: '環境之間不同的值放執行期設定', t: '`VITE_` 開頭的變數在 `npm run build` 時被換成字串寫進 bundle，換環境就要重建，正式環境跑的就不再是測試過的那個映像。改由 nginx 送 `/config.js`，`index.html` 在 module script 前面載入它。這個檔案誰都讀得到，不能放秘密。' },
      { b: '`/config.js` 的兩種來源', t: 'ConfigMap 掛整個目錄：改了會自動更新，nginx 不用重啟；用 `subPath` 掛單一檔案不會更新。官方映像的 templates 在啟動時用 envsubst 產生：值只在啟動時讀，要 `kubectl rollout restart`，漏了變數 nginx 啟動失敗。' },
      { b: '前端的 Deployment', t: '以 UID 101、唯讀根檔案系統執行，`/tmp` 掛 emptyDir。探針打 `/index.html` 就夠了，不打 `/api`：後端一停，所有前端 Pod 都會被移出 Service。`worker_processes auto` 依節點的 CPU 數開 worker，不看 Pod 的 limit，寫成固定的數字比較好估記憶體。' },
      { b: '子路徑部署：三個地方對同一個前綴', t: 'Vite 的 `base`（Vue Router 用 `import.meta.env.BASE_URL`）、nginx 的目錄與 location、HTTPRoute 或 Ingress 的前綴。整條路不改寫路徑；手寫在 `index.html` 的路徑（例如 `config.js`）要自己帶上前綴。' },
      { b: '滾動更新時的 chunk 404', t: '舊頁面要舊 chunk，新映像裡已經沒有；更新進行中，新頁面的請求也可能打到舊 Pod。三種做法：監聽 `vite:preloadError` 重新載入、映像裡保留上一版的 assets、assets 放到共用且只增不刪的位置。不管哪一種，`index.html` 都要是 `no-cache`。' },
    ],
    checklist: [
      '能說明 VITE_ 變數為什麼換環境就要重建，並把環境之間不同的值改成由 /config.js 提供',
      '能寫出掛 ConfigMap 的前端 Deployment，並比較「掛成目錄」「subPath」「templates 加環境變數」三種做法在改值之後的行為',
      '能說出滾動更新後 chunk 404 的兩個方向，以及三種處理方式各自的代價',
    ],
    challenge: {
      task: '同一個前端映像搭兩份 ConfigMap，跑出兩個環境。叢集用 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 的 kind，映像用 [前端與 nginx 上 K8s](#/skill/spa-containers) 建好的那一個；兩個環境各用一個 namespace。套用之前先寫下：改了其中一份 ConfigMap 之後，`/config.js` 什麼時候變、Pod 會不會重啟。',
      deliver: '一份可以重跑的驗收腳本（`curl` 指令加預期輸出）、一次實際執行的結果，以及改 ConfigMap 前後的預測與觀察',
      check: [
        '兩個環境的映像 digest 相同、`/config.js` 內容不同',
        '`grep` `dist/` 找不到任何一個環境的網址',
        '改 ConfigMap 之後 `/config.js` 的內容變了，Pod 的重啟次數沒有增加',
        '預測在執行前寫下，和結果並排',
      ],
      twist: '`/config.js` 改成用官方映像的 templates 從環境變數產生。先預測：改了 ConfigMap 之後內容什麼時候變、漏設一個變數時會看到什麼。',
    },
    refs: [
      { label: 'Vite：Env Variables and Modes', url: 'https://vite.dev/guide/env-and-mode' },
      { label: 'Docker Hub：nginx 官方映像（templates）', url: 'https://hub.docker.com/_/nginx' },
      { label: 'Kubernetes：ConfigMaps', url: 'https://kubernetes.io/docs/concepts/configuration/configmap/' },
    ],
  },
  'spa-api-routing': {
    map: {
      names: [
        { n: '保留 nginx 當入口／HTTPRoute 依路徑分流', t: '前者 Gateway 只到 nginx，`/api` 由 nginx 轉給後端的 Service；後者 `/api` 直接到後端、`/` 到只送靜態檔的 nginx，前後端各自更新。' },
        { n: '`PathPrefix`', t: 'Gateway API 的前綴比對一段一段比：`/api` 符合 `/api/patients`，不符合 `/api-docs`；規則之間長的優先，和書寫順序無關。nginx 的 `location /api` 是字串前綴，會比對到 `/api-docs`。' },
        { n: '`URLRewrite`（`ReplacePrefixMatch`）', t: '在 Gateway 這層去掉或換掉前綴。屬於 Extended 支援等級，實作可以不支援；要不要用看後端的路由有沒有 `/api`。' },
        { n: 'Service 名稱當 upstream', t: '第一條路的 nginx 把 upstream 改指 `clinic-api`；啟動時解析不到就起不來（`host not found in upstream`）。' },
        { n: '`X-Forwarded-Proto`', t: 'TLS 在 Gateway 終止後，nginx 的 `$scheme` 是 http；要轉送 `$http_x_forwarded_proto`，後端才知道原本是 https。' },
        { n: '上游閒置逾時', t: '直接連 gunicorn 的那一層（nginx 的 `keepalive_timeout` 或 Gateway 的設定）要比 gunicorn 的 `--keep-alive` 短，否則偶發 502 或 503；Envoy Gateway 預設 1 小時。' },
      ],
      ask: [
        '`/api` 由誰轉給後端：保留 nginx 當入口，還是 HTTPRoute 依路徑分流；後端路由有沒有 `/api` 前綴、要不要改寫。',
        '直接連 gunicorn 的那一層的閒置逾時設多少，要比 gunicorn 的 `--keep-alive` 短。',
        'TLS 在哪一層終止，`X-Forwarded-Proto` 與客戶端 IP 怎麼傳到後端。',
        'NetworkPolicy 放行誰連到後端：前端的 nginx，還是 Gateway 的代理 Pod。',
      ],
      prompt: '門診掛號系統搬上 Kubernetes，路由用 HTTPRoute 依路徑分流：`/api` 到 `clinic-api`（後端路由本來就有 `/api`，不改寫），`/` 到只送靜態檔的 `clinic-web`，兩條規則都用 `PathPrefix`。Envoy Gateway 對後端的閒置逾時設 60 秒，比 gunicorn 的 `--keep-alive` 75 秒短。NetworkPolicy 加一條，放行 Gateway 的代理 Pod 所在的 namespace 連到 `clinic-api`。',
      verify: [
        { c: '分流', t: '`curl -i` 打 `/api/health`、`/api-docs/`、`/patients/123`，只有第一個由後端回應；`/api-docs/` 跑到後端，代表 nginx 寫成沒有結尾斜線的 `location /api`。' },
        { c: '全部 404', t: '分流後所有 API 都 404，先對照後端的路由有沒有 `/api` 前綴，再看 HTTPRoute 有沒有多做或少做 `ReplacePrefixMatch`。' },
        { c: '偶發 503', t: '分流後偶發 `upstream connect error or disconnect/reset before headers`，先比對 Gateway 對後端的閒置逾時和 gunicorn 的 `--keep-alive`，前者較長就要調短。' },
        { c: '改寫有沒有生效', t: '用了 `URLRewrite` 的話，`kubectl describe httproute` 看 status 有沒有被接受；它屬於 Extended 支援等級，實作可以不支援。' },
        { c: '轉址的 scheme', t: '保留 nginx 當入口時，後端產生的轉址變成 `http://`，代表 nginx 還在送 `X-Forwarded-Proto $scheme`。' },
      ],
    },
    points: [
      { b: '搬上 K8s 的兩條路', t: '保留 nginx 當入口：upstream 改指 `clinic-api` 的 Service，Gateway 只到 nginx，設定少改但路由分在兩層。由 HTTPRoute 依路徑分流：`/api` 直接到後端、`/` 到只送靜態檔的 nginx，前後端各自更新。兩條路的 `/api` 都和頁面同源，不用 CORS。' },
      { b: '`PathPrefix` 一段一段比', t: 'Gateway API 的優先序是 `Exact` 先於 `PathPrefix`，`PathPrefix` 之間長的優先，規則的書寫順序不影響結果。`/api` 符合 `/api`、`/api/`、`/api/patients`，不符合 `/api-docs`；Ingress 的 `pathType: Prefix` 也一樣。' },
      { b: '要不要去掉 `/api` 看後端的路由', t: '後端路由本來就帶 `/api` 就原樣轉送；沒有才在 Gateway 用 `URLRewrite` 的 `ReplacePrefixMatch` 去掉。它屬於 Extended 支援；Ingress 本身沒有改寫的欄位，只能靠各 controller 的 annotation。' },
      { b: '第一條路要改的三個地方', t: 'upstream 的主機名稱換成 Service（啟動時解析不到，nginx 起不來）；`X-Forwarded-Proto` 改送 `$http_x_forwarded_proto`（TLS 在 Gateway 終止）；`location /api/` 加上結尾斜線。' },
      { b: '閒置逾時的規則不變', t: '不論哪條路，直接連 gunicorn 的那一層，閒置逾時都要比 `--keep-alive` 短。nginx 的 upstream `keepalive_timeout` 預設 60 秒；Envoy Gateway 預設 1 小時，要用 BackendTrafficPolicy 調短。sync worker 不支援持久連線，這條規則在 gthread、gevent 這類 worker 上才有意義。' },
    ],
    checklist: [
      '能比較「保留 nginx 當入口」與「HTTPRoute 依路徑分流」，寫出各自的 manifest，並說出換了前面那一層之後，要調哪個閒置逾時才能避免偶發的 502 或 503',
      '能判斷一個請求在 PathPrefix 規則下會被送到哪個 Service、後端收到什麼路徑，並說明它和 nginx 的 location 字串前綴差在哪',
      '能列出保留 nginx 當入口時要改的三個地方，以及各自沒改會看到的錯誤',
    ],
    challenge: {
      task: '用 HTTPRoute 把 `/api` 送到後端、`/` 送到前端。叢集用 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 的 kind，`clinic-web` 照 [前端的執行期設定](#/skill/spa-runtime-config) 部署好。套用之前先跑本課的分流模擬，寫下 `/api/board`、`/api-docs/`、`/patients/123` 各由誰回應的預測。',
      deliver: '一份可以重跑的驗收腳本（`curl` 指令加預期輸出）、一次實際執行的結果，以及執行前的預測',
      check: [
        '`/api/board` 由後端回應、`/api-docs/` 回到前端',
        '寫出 Gateway 對後端的閒置逾時與後端的 keep-alive 秒數（參考專案用 uvicorn，看 `--timeout-keep-alive`，預設 5 秒），前者比後者短',
        '預測在執行前寫下，和結果並排',
      ],
      twist: '後端改版，路由不再帶 `/api` 前綴。先預測驗收腳本的哪幾項結果會變，再決定 HTTPRoute 要改哪裡。',
    },
    refs: [
      { label: 'Kubernetes：Gateway API', url: 'https://kubernetes.io/docs/concepts/services-networking/gateway/' },
      { label: 'Kubernetes：Ingress', url: 'https://kubernetes.io/docs/concepts/services-networking/ingress/' },
    ],
  },
}
