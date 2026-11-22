// 題庫：P11 新課（p3 批）：spa-containers、spa-runtime-config、spa-api-routing
export default [
  {
    skill: 'spa-containers',
    questions: [
      {
        q: '下面這份設定裡，瀏覽器請求 `/assets/index-3f9c2a1b.js`（檔案存在）時，回應會帶哪些標頭？',
        code: 'server {\n    root /usr/share/nginx/html;\n    add_header X-Content-Type-Options "nosniff" always;\n\n    location /assets/ {\n        try_files $uri =404;\n        add_header Cache-Control "public, max-age=31536000, immutable" always;\n    }\n\n    location / {\n        try_files $uri $uri/ /index.html;\n    }\n}',
        lang: 'nginx',
        options: [
          '只有 Cache-Control；server 層的 X-Content-Type-Options 不會出現',
          'Cache-Control 與 X-Content-Type-Options 兩個都有，server 層的設定會套到每個 location',
          '只有 X-Content-Type-Options；location 裡的 add_header 要寫在 try_files 前面才會生效',
          '兩個都沒有，因為 add_header 對 try_files 找到的靜態檔不起作用',
        ],
        answer: 0,
        explain: 'nginx 的 add_header 只有在「目前這一層完全沒有 add_header」時才繼承上一層。`/assets/` 自己寫了一個 Cache-Control，server 層的 nosniff 就不算了；反而是沒有任何 add_header 的 `location /` 會繼承到 nosniff。指令在 location 裡的書寫順序不影響 add_header，靜態檔的回應也會帶標頭。修法是在 `/assets/` 再寫一次 nosniff、用 include 共用，或 nginx 1.29.3 起用 `add_header_inherit merge;`。',
      },
      {
        q: "使用者回報「畫面跟測試環境不一樣」。在主機上執行 `docker inspect clinic-nginx --format '{{json .Mounts}}'`，輸出有一筆 `Destination` 是 `/etc/nginx/html` 的 bind mount。這代表什麼、該怎麼改？",
        options: [
          'dist 已經在建置時 COPY 進映像，看映像的 tag 就知道跑的是哪一版，不用改',
          'nginx 的設定檔是掛進來的、dist 在映像裡；把設定檔改成 COPY 進映像就查得到版本',
          '前端檔案是執行時從主機目錄掛進來的；改成建置時打包進映像，tag 用 commit SHA',
          '容器以 root 執行才會出現 bind mount；改用 nginx-unprivileged 之後就查得到版本',
        ],
        answer: 2,
        explain: '`Destination` 是 nginx 送靜態檔的目錄，代表映像裡只有 nginx，前端版本取決於主機上那個目錄，每台可能不同，也沒有版本紀錄。建置時把 dist COPY 進映像，一個映像就是一個完整的前端版本：看 tag 知道是哪個 commit，回滾換回上一個 tag。輸出是 `[]` 才代表 dist 已經在映像裡；bind mount 和容器是不是以 root 執行無關。',
      },
      {
        q: '原本的設定只有一個 `location /`，寫著 `try_files $uri $uri/ /index.html;`。瀏覽器請求已經不存在的 `/assets/Billing-77aa1c2e.js`，會收到什麼？',
        options: [
          '404：`try_files` 找不到 `$uri` 就直接結束，不會再試後面的參數',
          '200 與 index.html 的內容，`Content-Type` 是 text/html，瀏覽器拒絕把它當成 JS 執行',
          '304：檔名帶 hash 的檔案可以長效快取，瀏覽器沿用上一版的 Billing chunk',
          '301 轉址到 `/index.html`，瀏覽器的網址列跟著變成首頁，再由前端路由接手',
        ],
        answer: 1,
        explain: '`try_files` 依序試每個參數，最後一個 `/index.html` 是內部轉址，所以不存在的 assets 也被換成 index.html，回 200、`Content-Type: text/html`。這是內部轉址，不是 301，網址不變。修法是替 `/assets/` 開一個 location 寫 `try_files $uri =404;`，找不到就回 404；這也避免一份 HTML 以一年的快取存在 `.js` 的網址下。',
      },
    ],
  },
  {
    skill: 'spa-runtime-config',
    questions: [
      {
        q: '前端程式用 `import.meta.env.VITE_SSO_URL` 取得登入網址。CI 用測試環境的值建好映像，測試通過後把同一個映像部署到正式環境，正式環境的 Pod 也設定了正確的環境變數 `VITE_SSO_URL`，使用者卻還是被導到測試的 SSO。原因是什麼？',
        options: [
          'Pod 的環境變數只在容器啟動時讀一次，要 `kubectl rollout restart` 才會讀到新值',
          'nginx 預設不把容器的環境變數傳給前端，要在設定裡加 `env VITE_SSO_URL;`',
          '`VITE_` 開頭的變數在 `npm run build` 時就被換成字串寫進 bundle，執行時的環境變數不會改變它',
          '瀏覽器快取了舊的 bundle，正式環境的使用者清除快取後就會導到正確的網址',
        ],
        answer: 2,
        explain: 'Vite 在建置時把 `import.meta.env.VITE_*` 直接替換成當時的值，bundle 裡留下的是字串，容器執行時根本不看環境變數，重啟、改 nginx 或清快取都沒用。要讓同一個映像跑在不同環境，改用執行期設定：由 nginx 送 `/config.js`，內容來自每個環境的 ConfigMap。`env` 指令只是讓 nginx 的 worker 保留環境變數，不會送給瀏覽器。',
      },
      {
        q: '前端的 Deployment 這樣掛 `config.js`。改了 ConfigMap 之後過了很久，`curl /config.js` 還是舊內容。原因是？',
        code: 'volumeMounts:\n  - name: runtime-config\n    mountPath: /usr/share/nginx/html/config.js\n    subPath: config.js\nvolumes:\n  - name: runtime-config\n    configMap:\n      name: clinic-web-config',
        lang: 'yaml',
        options: [
          'nginx 啟動時把靜態檔讀進記憶體，之後不再讀磁碟，要 reload 才會重新讀檔',
          '`/config.js` 設了 `no-cache`，`curl` 會沿用上一次的回應，要加 `-H "Cache-Control: no-cache"`',
          'ConfigMap 的更新要等 Pod 的 readinessProbe 下一次失敗，才會同步到 volume',
          '用 `subPath` 掛的單一檔案不會跟著 ConfigMap 更新，掛成整個目錄才會',
        ],
        answer: 3,
        explain: '以目錄掛載的 ConfigMap，內容改了之後檔案過一段時間會跟著換，nginx 下一次就送出新內容，不必重啟 Pod；用 `subPath` 掛單一檔案則不會更新。把 ConfigMap 掛成一個目錄（例如 `/etc/clinic-web/`），nginx 用 `alias` 從那裡送出。nginx 每次請求都從磁碟讀靜態檔；`curl` 沒有快取；ConfigMap 的同步和探針無關。',
      },
      {
        q: '09:05 部署 v2，滾動更新完成。09:20，一位從 09:00 就開著掛號頁的櫃台人員第一次點「批價」，頁面沒反應，console 出現 `Failed to fetch dynamically imported module`。原因是？',
        options: [
          '舊頁面要的是 v1 的 chunk，檔名帶 v1 的 hash；新的 Pod 裡只有 v2 的 assets，回 404',
          '`index.html` 設了 `no-cache`，瀏覽器每次換頁都重新驗證，順便把載入到一半的 Billing chunk 取消了',
          '帶 hash 的 assets 快取一年，瀏覽器拿快取裡過期的 Billing chunk 來執行而失敗',
          '滾動更新換掉了 Service 的 ClusterIP，舊頁面還連著原本的位址，所以請求送不出去',
        ],
        answer: 0,
        explain: 'Vite 把每個路由頁面拆成獨立的 chunk，點到才載入。舊頁面是 v1 的 `index.html` 載入的，要的是 v1 的 `/assets/Billing-77aa1c2e.js`，而每個 Pod 的映像裡只有 v2 的 assets。處理方式有三種：前端監聽 `vite:preloadError` 重新載入、映像裡保留上一版的 assets、assets 放到共用且只增不刪的位置。`no-cache` 是讓 `index.html` 每次確認，沒有它瀏覽器會一直拿舊的 `index.html` 去要舊 chunk；這個 chunk 之前沒載入過，快取裡沒有；滾動更新不會換 Service 的 ClusterIP。',
      },
    ],
  },
  {
    skill: 'spa-api-routing',
    questions: [
      {
        q: '原本 nginx 站在最前面轉發 `/api`，upstream 的 `keepalive_timeout` 是 60 秒、gunicorn 的 `--keep-alive` 是 75 秒（gthread worker），一直相安無事。搬上 K8s 後改成由 Envoy Gateway 的 HTTPRoute 直接把 `/api` 送到後端，之後在離峰時段偶發 503，訊息是 `upstream connect error or disconnect/reset before headers. reset reason: connection termination`。最合適的處理是？',
        options: [
          '把 gunicorn 的 `--keep-alive` 調成 0，讓每個請求都開新連線，避免重用連線',
          '把 HTTPRoute 的 `/api` 規則加上 `ReplacePrefixMatch: /`，讓後端收到正確的路徑',
          '把 clinic-api 的 readinessProbe 間隔調短，讓 Gateway 更快發現後端不可用',
          '用 BackendTrafficPolicy 把 Gateway 對後端的連線閒置逾時調到比 75 秒短，例如 60 秒',
        ],
        answer: 3,
        explain: '直接連 gunicorn 的那一層從 nginx（60 秒）換成了 Envoy，Envoy Gateway 對上游的閒置逾時預設 1 小時，比 gunicorn 的 75 秒長；gunicorn 先關掉閒置連線，Envoy 拿那條連線送請求就被重設，離峰時閒置連線多，所以更常發生。規則跟原本一樣：前面那一層的閒置逾時要比 gunicorn 的 keep-alive 短。調成 0 是讓 gunicorn 不再保留閒置連線，每個請求多一次建立連線的成本，只是避開問題；改寫路徑處理的是 404；readiness 管的是 Pod 是否在後端清單裡，和重用已關閉的連線無關。',
      },
      {
        q: '這份 HTTPRoute 把 `/` 的規則寫在 `/api` 前面。`/api/patients` 與 `/api-docs/` 各送到哪個 Service？',
        code: 'rules:\n  - matches:\n      - path: { type: PathPrefix, value: / }\n    backendRefs:\n      - name: clinic-web\n        port: 80\n  - matches:\n      - path: { type: PathPrefix, value: /api }\n    backendRefs:\n      - name: clinic-api\n        port: 9696',
        lang: 'yaml',
        options: [
          '兩個都到 clinic-web：規則由上往下比對，寫在前面的 `/` 先符合就不再往下看',
          '兩個都到 clinic-api：`/api` 是比較長的前綴，而兩個路徑的開頭都是 `/api`',
          '`/api/patients` 到 clinic-api，`/api-docs/` 到 clinic-web：長的前綴優先，一段一段比',
          '`/api/patients` 到 clinic-web，`/api-docs/` 到 clinic-api：`/api` 只比對沒有下一段的路徑',
        ],
        answer: 2,
        explain: 'Gateway API 的優先序和書寫順序無關：`Exact` 先於 `PathPrefix`，`PathPrefix` 之間字元數多的優先，所以 `/api/patients` 由 `/api` 那條接走。`PathPrefix` 是一段一段比，`/api` 符合 `/api`、`/api/`、`/api/patients`，不符合 `/api-docs`，後者落到 `/`。nginx 的 `location /api` 是字串前綴，才會把 `/api-docs` 也比對進去。',
      },
      {
        q: '搬上 K8s 後保留 nginx 當入口，TLS 在 Gateway 終止。nginx 沿用 `proxy_set_header X-Forwarded-Proto $scheme;`，結果登入後 Flask 產生的轉址網址變成 http 開頭。原因是？',
        options: [
          'nginx 收到的是 Gateway 轉來的 http，`$scheme` 是 http；要改成轉送 `$http_x_forwarded_proto`',
          'Service 的 port 是 9696 不是 443，kube-proxy 轉送連線時把請求的協定改成了 http',
          '`proxy_set_header` 寫在 location 裡不會生效，X-Forwarded-Proto 要搬到 server 層才送得出去',
          'upstream 改成 Service 名稱之後，nginx 不再替轉給 `clinic-api` 的請求加任何 X-Forwarded 標頭',
        ],
        answer: 0,
        explain: '原本 nginx 自己終止 TLS，`$scheme` 是 https。現在 TLS 在 Gateway 終止，nginx 收到的是 http，`$scheme` 也就是 http，Flask 以為請求是 http，產生錯的轉址網址。把 Gateway 帶來的值轉下去：`proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;`。kube-proxy 做的是連線層級的轉送，不改請求內容；`proxy_set_header` 寫在 location 裡會生效，和 upstream 指向誰無關。',
      },
    ],
  },
]
