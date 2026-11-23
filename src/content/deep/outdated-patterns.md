## 問題：能動的確認視窗，鍵盤一按就漏

門診系統要在「我的掛號」加一個「看診須知」視窗。AI 產生的程式點按鈕會跳出視窗，按「我知道了」會關掉：

```html
<button id="open">看診須知</button>

<div class="overlay" id="notice" role="dialog" aria-modal="true" hidden>
  <div class="panel">
    <h2>看診須知</h2>
    <p>請攜帶健保卡，報到時間為看診前 30 分鐘。</p>
    <button class="close">我知道了</button>
  </div>
</div>

<script>
  const modal = document.querySelector('#notice')
  function open() {
    modal.hidden = false
    document.body.style.overflow = 'hidden'          // 鎖住背景捲動
    modal.querySelector('.close').focus()
    document.addEventListener('keydown', onKey)
  }
  function close() {
    modal.hidden = true
    document.body.style.overflow = ''
    document.removeEventListener('keydown', onKey)
  }
  function onKey(e) {
    if (e.key === 'Escape') close()
    if (e.key === 'Tab') {                            // 自己寫的 focus trap
      e.preventDefault()
      modal.querySelector('.close').focus()
    }
  }
  document.querySelector('#open').addEventListener('click', open)
  modal.querySelector('.close').addEventListener('click', close)
</script>
```

「點按鈕出現視窗、點關閉視窗消失」兩條測試都通過。換成只用鍵盤與螢幕閱讀器操作：

1. 關掉視窗後焦點留在已經隱藏的按鈕上，下一次按 Tab 從頁首重新開始。
2. 視窗裡之後加了第二顆按鈕，focus trap 只認得「我知道了」，Tab 永遠停在同一顆。
3. 螢幕閱讀器的瀏覽模式（不用 Tab，用方向鍵逐行讀）照樣讀得到背景的內容，`aria-modal` 在部分組合下沒有效果。
4. `overflow: hidden` 讓捲軸消失，整頁往右跳了 15px；手機 Safari 上背景照樣捲得動。
5. 另一個頁面也開了同樣的視窗，兩份 `keydown` 監聽互相搶 Esc。

這段程式重做了一個瀏覽器內建的元件。原生的 `<dialog>` 用 `showModal()` 開啟時，背景自動 inert（點不到、Tab 不到、輔助科技也讀不到）、Esc 關閉、關閉後焦點回到開啟前的元素。

## 過時寫法的三類，用 Baseline 判斷能不能直接用

| 類型 | 例子 | 怎麼處理 |
|---|---|---|
| 有原生替代，而且已經 Widely available | 自己寫的 focus trap、`JSON.parse(JSON.stringify())`、`scroll` 事件判斷元素進入畫面 | 直接換成原生寫法 |
| 有原生替代，但還是 Newly available | `popover`、`light-dark()`、`fetchpriority`、`content-visibility` | 對照專案的瀏覽器目標；在目標內就用，不在就功能偵測加退路 |
| 「新寫法」仍是 Limited availability | `scheduler.yield()`、`fetchLater()`、`focusgroup`、`<dialog closedby>`、`Temporal` | 只能當加分寫法，舊寫法要留著當退路 |

Baseline 標示在 MDN 每個功能頁上方：

| 狀態 | 意思 | web-features 的欄位 |
|---|---|---|
| Widely available | Chrome、Edge、Firefox、Safari（含手機版）都支援，滿 30 個月 | `baseline: 'high'`、`baseline_high_date` |
| Newly available | 上面這些瀏覽器的最新版都支援了，以年份稱呼，例如「Baseline 2024」 | `baseline: 'low'`、`baseline_low_date` |
| Limited availability | 還有核心瀏覽器不支援 | `baseline: false` |

## 開頭的視窗改成原生 `<dialog>`

```html
<button id="open" type="button">看診須知</button>

<!-- 不寫 role="dialog" 與 aria-modal：showModal() 開的 <dialog> 本身就是 modal 的 dialog -->
<dialog id="notice" aria-labelledby="notice-title">
  <h2 id="notice-title">看診須知</h2>
  <p>請攜帶健保卡，報到時間為看診前 30 分鐘。</p>
  <form method="dialog">
    <button>我知道了</button>
  </form>
</dialog>

<style>
  /* 加分寫法：支援的瀏覽器上，在 backdrop 或 dialog 裡捲動不會帶動背景；不改 body 的 overflow */
  dialog:modal { overscroll-behavior: contain; }
  dialog::backdrop { overflow: hidden; overscroll-behavior: contain; background: rgb(0 0 0 / 0.4); }
</style>

<script type="module">
  const dialog = document.querySelector('#notice')
  // 背景 inert、Esc 關閉、關閉後焦點回到 #open，都由瀏覽器處理
  document.querySelector('#open').addEventListener('click', () => dialog.showModal())
</script>
```

刪掉的程式：focus trap、Esc 監聽、`body` 的 `overflow`、手動把焦點還回去。

## 最常見的兩個錯誤

| 現象或訊息 | 原因 | 修法 |
|---|---|---|
| `<dialog>` 開了，背景還點得到、Esc 沒反應 | 用 `dialog.show()` 或 `open` 屬性開啟，不是 modal | 改用 `showModal()`；Console 執行 `$0.matches(':modal')` 確認 |
| `TypeError: scheduler.yield is not a function`，只在 Safari | 把 Limited availability 的 API 當成唯一寫法 | 功能偵測，退回 `setTimeout` |

:::stop 讀到這裡可以先停：會用 Baseline 判斷一個功能能不能直接用，把自己拼的 modal 換成原生 `<dialog>`。後面是舊寫法與現在寫法的完整對照表、讓 agent 先查再寫的設定、`structuredClone` 與錯誤訊息表，審 AI 產出或替 coding agent 定規範時再回來查。

## AI 為什麼給舊寫法，又為什麼會給太新的寫法

`<dialog>` 在 2022 年 3 月獲主要瀏覽器支援，2024 年 9 月成為 Baseline Widely available。Modern Web Guidance 的 README 指出，模型訓練資料偏向舊寫法。要求改用新 API 時，也要核對目標瀏覽器，避免在 Safari 等環境遇到 `TypeError`。

## Baseline 的來源與專案的瀏覽器目標

用 web-features 的 `data.json` 查狀態。Baseline 2024 涵蓋截至 2024 年成為 Newly available 的功能。院內舊電腦要列出具體版本，見 [瀏覽器支援與 Baseline](#/skill/browser-support)。

## 對照表：舊寫法與現在的寫法

下表的 Baseline 狀態與日期取自 web-features 3.46.0（2026-11 核對），出處是 Modern Web Guidance 1.0.1 的指南 id。

**HTML 與元件**

| 舊寫法 | 現在的寫法 | Baseline | 指南 id |
|---|---|---|---|
| `div` 加 `position: fixed` 的 modal、自己寫 focus trap 與 Esc 監聽、加 `role="dialog"` 與 `aria-modal` | `<dialog>` 加 `showModal()`，不加 `role` 與 `aria-modal` | Widely available（2022-03 起，2024-09 widely） | `dialog` |
| 背景每個元素加 `aria-hidden` 與 `tabindex="-1"` | 背景容器加 `inert` | Widely available（2023-04 起，2025-10 widely） | `accessibility` |
| 下拉選單自己算座標、在 `document` 監聽點擊判斷點到外面 | `popover` 屬性：點外面關閉、放進 top layer | Newly available（2025-01） | `menu`、`html` |
| `div` 加 `@click` 與 `aria-expanded` 做手風琴 | `<details>` 與 `<summary>`；同組只開一個用 `name` | `<details>` Widely；`name` 是 Newly（2024-09） | `accordion` |

**CSS**

| 舊寫法 | 現在的寫法 | Baseline | 指南 id |
|---|---|---|---|
| JS 在欄位出錯時替外層加 `.has-error` class | `.field:has(input:user-invalid)` | `:has()` Widely（2023-12 起，2026-06 widely） | `style-parent-with-has` |
| 卡片元件用視窗寬度的 media query | container query：`container-type: inline-size` 加 `@container` | Widely（2023-02 起，2025-08 widely） | `size-aware-styling`、`responsive-design` |
| 手機全高用 `height: 100vh`，網址列出現時底部被蓋住 | `100dvh` | Widely（2022-12 起，2025-06 widely） | `responsive-design` |
| 亮色與暗色各寫一份變數，用 JS 切 class | `color-scheme: light dark` 加 `light-dark()` | Newly（2024-05） | `dark-mode` |
| 開 modal 時 `body { overflow: hidden }` 鎖捲動 | `dialog:modal { overscroll-behavior: contain }` 與 `dialog::backdrop { overflow: hidden; overscroll-behavior: contain }` | Limited（對不能捲動的容器生效：Chrome、Edge 144、Firefox 150 起）；只當加分，不支援時背景仍是 inert | `prevent-page-scroll-under-modal-dialog` |

**JavaScript**

| 舊寫法 | 現在的寫法 | Baseline | 指南 id |
|---|---|---|---|
| `JSON.parse(JSON.stringify(obj))` 深拷貝 | `structuredClone(obj)` | Widely（2022-03 起，2024-09 widely） | `js` |
| `reduce` 分組 | `Object.groupBy()`、`Map.groupBy()` | Widely（2024-03 起，2026-09 widely） | `js` |
| `[...arr].sort()`、`arr.slice().reverse()` | `toSorted()`、`toReversed()`、`with()` | Widely（2023-07 起，2026-01 widely） | `js` |
| `setTimeout` 加 `AbortController` 自己做逾時 | `AbortSignal.timeout(8000)` | Widely（2024-04 起，2026-10 widely） | `js` |
| 自己加減 8 小時換算台北時間 | `Intl.DateTimeFormat` 的 `timeZone: 'Asia/Taipei'`；日期計算用 `Temporal` | `Intl` Widely；`Temporal` 是 Limited（Safari 還沒有），要 polyfill | `coordinate-global-events` |

**表單**

| 舊寫法 | 現在的寫法 | Baseline | 指南 id |
|---|---|---|---|
| `input:invalid` 一進頁面就把空的必填欄位標紅，或自己記「碰過了沒」 | `:user-invalid`：使用者改過或送出後才符合 | Widely（2023-11 起，2026-05 widely） | `validate-input-after-interaction` |
| `textarea` 每次輸入用 JS 量 `scrollHeight` 調高度 | `field-sizing: content` | Newly（2026-06）；不支援時維持固定高度 | `form-fields-automatically-fit-contents` |

**效能**

| 舊寫法 | 現在的寫法 | Baseline | 指南 id |
|---|---|---|---|
| 所有圖片都 `loading="lazy"`，包含首屏主圖 | 首屏主圖不 lazy，加 `fetchpriority="high"` | `fetchpriority` Newly（2024-10） | `optimize-image-priority` |
| `scroll` 事件加 throttle 判斷元素進入畫面 | `IntersectionObserver` | Widely（2019-03 起） | `scroll-position-aware-elements` |
| 一個迴圈跑完幾千筆才讓出主執行緒 | 每 50 毫秒 `await scheduler.yield()`，沒有就退回 `setTimeout` | Limited（Chrome 129、Firefox 142 起，Safari 還沒有） | `break-up-long-tasks` |
| 長頁面一次排版所有區塊 | 視窗外的區塊加 `content-visibility: auto` 與 `contain-intrinsic-size` | Newly（2025-09） | `defer-rendering-heavy-content` |
| `unload` 事件裡插一個 `<img>` 送統計 | `visibilitychange` 變成 hidden 時 `navigator.sendBeacon()`；支援的瀏覽器用 `fetchLater()` | `sendBeacon` Widely；`fetchLater` 是 Limited（Chrome、Edge 135 起） | `full-session-analytics` |

**資安**

| 舊寫法 | 現在的寫法 | Baseline | 指南 id |
|---|---|---|---|
| `el.innerHTML = 使用者輸入` | 純文字用 `textContent`；一定要放 HTML 時用 DOMPurify 消毒，支援的瀏覽器用 Sanitizer API 的 `setHTML()` | Sanitizer API 是 Limited（Chrome 146、Firefox 148 起） | `sanitize-untrusted-html` |
| 靠 code review 抓 `innerHTML` | CSP 的 `require-trusted-types-for 'script'` 加 Trusted Types 政策 | Newly（2026-02） | `trusted-types` |
| `event.origin.includes('example.org')` 判斷訊息來源 | `new URL(...).origin` 完整比對，先排除 `'null'` | `URL` Widely | `validate-origins` |

Invoker Commands（`<button command="show-modal" commandfor="notice">`）連必讀範例裡那一行 JavaScript 都可以省，但它是 Newly available（2025-12），目標是 Widely available 時要功能偵測並載入 polyfill，或維持 `showModal()`。

## Modern Web Guidance 的指南和標準不一樣時

GoogleChrome 在 npm 發布 Modern Web Guidance，由 Chrome、Edge、Firefox 與 MDN 團隊共同維護。指南的建議要依瀏覽器目標和標準驗收。

- `fetchLater()` 指南把退路交給 polyfill。`focusgroup` 從 Chrome、Edge 150 才支援。用最新 web-features 查支援狀態，並依 Safari 等目標瀏覽器安排退路。
- 指南用滑鼠開選單時把焦點留在按鈕。APG 的 Menu Button 範例會移到第一項。以 APG 與 WCAG 驗收無障礙行為。

## 讓 AI 先查再寫

### 1. 專案規範寫明瀏覽器目標

AI 每次都要先知道「能用到多新」。把這段放進 `AGENTS.md`（寫法見 [給 AI 的專案規範](#/skill/ai-project-rules)）：

```md
## 瀏覽器目標
- Baseline Widely available 的功能直接用。
- Newly available 的功能可以用，但要功能偵測，並附不支援時的退路；
  退路不超過 20 行、不新增套件。
- Limited availability 的功能只能當加分寫法，不能是唯一寫法。
- 院內櫃台有 Chrome 109：用到 Chrome 110 以後才有的 API 要改寫或退路。

## 先查再寫
- 寫 Dialog、Popover、選單、表單驗證、深拷貝、捲動效果、日期時區、
  插入 HTML 之前，先用 modern-web-guidance 查對應的指南。
- 不寫：自己的 focus trap 與 Esc 監聽、body 的 overflow: hidden、
  在 <dialog> 上加 role="dialog"、JSON.parse(JSON.stringify())。
- 交付時列出用到的新功能、Baseline 狀態與指南 id。
```

Modern Web Guidance 未讀到專案政策時，只直接採用 Widely available。若目標寫為 Baseline 2024，可直接採用截至該年納入 Baseline 的功能。

### 2. 給 agent 裝 Modern Web Guidance

Modern Web Guidance 1.0.1 有 209 份 Markdown 指南，列出 Baseline 狀態、瀏覽器版本和退路。CLI 需要 Node.js 22 以上，下載套件需連網。

```bash
# 互動式安裝到自己用的 agent
npx modern-web-guidance@latest install

# 不安裝也可以直接查：用 2–5 個英文字描述「要做的事」，不寫框架名稱
npx -y modern-web-guidance@latest search "modal dialog"
npx -y modern-web-guidance@latest search "prevent page scroll under modal"

# 讀指南全文，可以一次給好幾個 id
npx -y modern-web-guidance@latest retrieve "dialog,prevent-page-scroll-under-modal-dialog"
```

從 `search` 的 `[{ id, description }]` 挑指南，用 `retrieve` 讀全文。交付時列出指南與避開的錯誤。`legacy-scan` 只涵蓋部分指南，大範圍現代化時才用。沙箱需允許套件下載，離線時查 MDN。

### 3. 審查清單加一條：有沒有原生替代

在 diff 搜尋舊寫法，對照 [審 AI 的改動](#/skill/ai-review-diff)。

```bash
git diff main...HEAD | grep -nE "JSON\.parse\(JSON\.stringify|role=\"dialog\"|aria-modal|overflow ?= ?'hidden'|addEventListener\('(scroll|resize)'|\.innerHTML ?="
```

對每個舊寫法查原生替代，並核對新 API 的 Baseline 狀態與專案瀏覽器目標。

## 深拷貝：`structuredClone` 與 JSON 的差別

```js run
const appt = {
  id: 501,
  at: new Date('2026-11-20T01:30:00Z'),
  tags: new Set(['初診']),
  doctor: { name: '林醫師' },
}

const viaJson = JSON.parse(JSON.stringify(appt))
const viaClone = structuredClone(appt)

console.log('JSON：at 是', typeof viaJson.at, '，tags 是', JSON.stringify(viaJson.tags))
console.log('structuredClone：at 是 Date？', viaClone.at instanceof Date, '，tags 有', [...viaClone.tags])

viaClone.doctor.name = '王醫師'
console.log('改了副本，原本的醫師還是', appt.doctor.name)
```

JSON 會把 `Date` 轉成字串、`Set` 轉成空物件，並省略函式。`structuredClone` 保留前兩種型別，遇到函式或 DOM 節點會丟 `DataCloneError`。要驗證實際送出的 JSON 時，用 JSON 序列化。

## 其他錯誤訊息

| 現象或訊息 | 原因 | 修法 |
|---|---|---|
| `<dialog>` 開著時 axe 或 DevTools 顯示重複的 dialog 角色 | AI 在原生 `<dialog>` 上又加了 `role="dialog"`、`aria-modal="true"` | 拿掉兩個屬性 |
| `TypeError: Object.groupBy is not a function`，只在舊電腦 | 功能是 Widely available，但院內電腦的版本比 Baseline 舊 | 規範寫出具體版本；改寫或 polyfill（見 [瀏覽器支援與 Baseline](#/skill/browser-support)） |
| `DataCloneError: … could not be cloned.` | `structuredClone` 的對象裡有函式、DOM 節點或 Vue 的 Proxy | 只拷貝資料；Vue 的響應式物件先用 `toRaw()` |
| `npx modern-web-guidance` 一直沒有回應 | 沙箱沒放行網路，套件下載不到 | 先放行該指令的網路存取；離線時改查 MDN |
| AI 回報引用了一份指南，`retrieve` 卻查不到 | 模型自己編了指南 id | 要求附上實際的 `search` 輸出；查不到的出處不算 |

## 動手

1. 做這一課的程式題「把 AI 的舊式 modal 改成原生 `<dialog>`」：測試會檢查 `:modal`、背景 inert、關閉後焦點回到按鈕，以及沒有 `role="dialog"` 與 `body` 的 `overflow: hidden`。
2. 按深拷貝那段 `js run` 區塊的「在 Playground 開啟」，在 `appt` 裡加一個函式欄位，看 `structuredClone` 丟出的錯誤，再和 JSON 的結果比較。
3. 在自己的專案執行「審查清單加一條」那段的 `grep`，對每一筆查 MDN 的 Baseline 標示，分成「直接換」「加退路後換」「維持」三類。
4. 照「瀏覽器目標」那段改寫自己專案的 `AGENTS.md`，交給 AI 一個 Dialog 或表單驗證的小任務，檢查它有沒有先查指南、交付的表裡出處查不查得到。
5. 回頭讀 [AI 寫前端的常見錯誤](#/skill/ai-common-mistakes)（Vue 寫法的錯）與 [審 AI 的改動](#/skill/ai-review-diff)，把這一課的搜尋訊號加進審查順序。
