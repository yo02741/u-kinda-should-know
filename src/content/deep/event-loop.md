## 具體問題：「處理中…」從來沒出現過

月報頁有一顆「產生月報」按鈕，資料已經在 store 裡，有 5 萬筆掛號。AI 產生的處理函式：

```js
function generate() {
  status.value = '處理中…'
  report.value = buildReport(appointments.value)   // 分組、加總、排序，同步跑完
  status.value = '完成'
}
```

在櫃台那台舊電腦上，按下按鈕後狀態列沒有出現「處理中…」，旁邊搜尋框打的字也不出現。一秒多以後，狀態列直接變成「完成」，剛才打的字一次跳出來。Performance 分頁錄到主執行緒上一個一千多毫秒的 task，上面標著紅色三角形。

`status.value = '處理中…'` 執行了，但這個值沒有被畫到畫面上。JavaScript 與畫面更新都在主執行緒上，畫面只在一段程式跑完之後才有機會更新。`buildReport` 跑完時，`status` 已經是「完成」。

## 一輪事件迴圈：一個 task、所有 microtask、然後才渲染

```
┌──▶ 取出一個 task 執行，直到 call stack 清空
│      （整段 <script>、setTimeout 回呼、click 處理函式……）
│                │
│                ▼
│    清空 microtask queue
│      （then 回呼、await 之後的程式、queueMicrotask；途中新排進的也一起跑完）
│                │
│                ▼
│    渲染時機：到了該畫的時間、而且有變更才畫
│      requestAnimationFrame 回呼 → 算樣式 → 版面 → 繪製
│                │
└────────────────┘
```

一個 task 開始之後，一定跑到 call stack 清空才停；接著把 microtask 全部跑完；然後才輪到渲染與下一個 task。渲染的機會大約跟著螢幕的更新率出現（60 Hz 的螢幕約每 16.7 ms 一次），沒有東西要畫時跳過。task 跑到一半一定不會畫。

| 排進哪裡 | 來源 |
|---|---|
| task | 整段 `<script>`、`setTimeout` 與 `setInterval` 的回呼、使用者事件（`click`、`input`、`keydown`）的處理函式、`postMessage` 收到的訊息 |
| microtask | Promise 的 `then`、`catch`、`finally` 回呼、`await` 之後的程式、`queueMicrotask`、`MutationObserver` 的回呼 |
| 渲染之前 | `requestAnimationFrame` 的回呼 |

`fetch` 的回應回來時，瀏覽器用一個 task 讓 Promise 完成，接在它後面的 `then` 與 `await` 之後的程式則是 microtask。

## 最小範例：排出順序，並讓「處理中…」先畫出來

```js run
console.log('1 同步')
setTimeout(() => {
  console.log('5 timeout A')
  Promise.resolve().then(() => console.log('6 A 的 then'))
}, 0)
setTimeout(() => console.log('7 timeout B'), 0)
Promise.resolve().then(() => console.log('3 then'))
queueMicrotask(() => console.log('4 microtask'))
console.log('2 同步結束')

await new Promise((r) => setTimeout(r, 50))   // 等計時器的回呼跑完再結束
```

兩個 0 ms 的 `setTimeout` 回呼要等 script 跑完、microtask 清空才輪到。A 裡面排的 `then` 在 A 結束後馬上執行，比 B 早：每個 task 結束後都會先清 microtask。

要讓「處理中…」先畫出來，得讓目前的 task 結束，並等過一次渲染：

```js
// rAF 的回呼在下一次繪製前執行，在裡面排的 setTimeout 會在那次繪製之後才輪到
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

async function generate() {
  status.value = '處理中…'
  await nextPaint()                                // 「處理中…」先畫到畫面上
  report.value = buildReport(appointments.value)   // 仍是一個長 task，切段的寫法在選讀
  status.value = '完成'
}
```

## 最常見的兩個錯誤

| 現象 | 原因 | 修法 |
|---|---|---|
| 「處理中…」從來沒出現 | 改了狀態之後，同一個 task 裡接著跑長時間的計算 | 先 `await nextPaint()`，再計算 |
| 加了 `await Promise.resolve()` 或 `await nextTick()` 還是沒出現 | 兩者都只讓出到 microtask，microtask 清空前不渲染 | 讓出到 task，並等過一次繪製 |

:::stop 讀到這裡可以先停：排得出同步程式、microtask 與 task 的順序，會用 `nextPaint` 讓狀態先畫出來。後面是逐步的中間狀態、`await` 的切點、long task 的切段與 Vue 元件寫法，在按下按鈕畫面卡住或 Performance 出現長 task 時再回來讀。

## 最小範例的中間狀態

必讀那段程式前 9 行的逐步狀態：

| 時間點 | call stack | microtask queue | task queue | Console 多了 |
|---|---|---|---|---|
| 執行第 1 行 | script | | | 1 同步 |
| 執行第 2、6 行 | script | | A、B | |
| 執行第 7、8 行 | script | then、microtask | A、B | |
| 執行第 9 行 | script | then、microtask | A、B | 2 同步結束 |
| script 跑完 | then 回呼 | microtask | A、B | 3 then |
| | microtask 回呼 | | A、B | 4 microtask |
| （渲染時機） | | | A、B | |
| 取出 A | A | A 的 then | B | 5 timeout A |
| A 跑完 | A 的 then | | B | 6 A 的 then |
| 取出 B | B | | | 7 timeout B |

`setTimeout` 先把回呼交給計時器，時間到了才排進 task queue；0 ms 的計時器幾乎立刻到期，表格直接畫在 task queue 裡。

下面幾段在本站的 JavaScript 執行環境（Web Worker）裡跑，順序規則和主執行緒相同。執行環境在程式最後一行跑完時收集輸出，所以每段最後都等一下，讓計時器的回呼有機會執行。

## `await` 把函式切成兩半

```js run
const fetchBoard = () => Promise.resolve('101 診 12 號')

async function loadBoard() {
  console.log('B loadBoard 開始')
  const board = await fetchBoard()
  console.log('D await 之後：' + board)
}

console.log('A 同步開始')
setTimeout(() => console.log('F setTimeout'), 0)
loadBoard()
Promise.resolve().then(() => console.log('E then'))
console.log('C 同步結束')

await new Promise((r) => setTimeout(r, 50))
```

輸出順序是 A、B、C、D、E、F。呼叫 `loadBoard()` 時，第一個 `await` 之前的程式同步執行；遇到 `await`，函式暫停、離開 call stack，呼叫它的地方繼續往下。`fetchBoard()` 回傳的 Promise 已經完成，`await` 之後的程式就排進 microtask queue；`E then` 在它之後才排進去，所以 D 比 E 早。`F setTimeout` 是 task，最後才執行。

## 畫面在什麼時候更新

- 改 DOM（`el.textContent = '處理中…'`）會立刻改到 DOM 物件上，但畫面要等這個 task 和所有 microtask 都跑完、到了渲染時機才畫。
- Vue 改狀態時不會立刻改 DOM：同一輪的變更先收集起來，排一個 microtask 一次更新。改三次 `count`，DOM 從 0 直接變成 3，中間的 1、2 不會出現在 DOM 上，更不會畫出來。`await nextTick()` 等的就是這個 microtask；它之後 DOM 是新的，但還沒畫到畫面上。
- `await Promise.resolve()` 或 `await nextTick()` 都只讓出到 microtask，瀏覽器在 microtask 清空之前不渲染。要讓「處理中…」先畫出來，得讓目前的 task 結束，並等過一次渲染：`await new Promise((r) => requestAnimationFrame(() => setTimeout(r)))`。`requestAnimationFrame` 的回呼在下一次繪製前執行，在裡面排的 `setTimeout` 會在那次繪製之後才輪到。
- 只用 `setTimeout(r, 0)` 讓出主執行緒，瀏覽器有機會在兩個 task 之間渲染，但不保證一定畫：0 ms 的計時器可能在下一次繪製之前就輪到。

## `setTimeout` 的延遲是「最少」

`setTimeout(fn, 100)` 的意思是「至少 100 ms 之後把 `fn` 排進 task queue」，實際執行還要等前面的 task 與 microtask 跑完。主執行緒被一個 1 秒的 task 佔住時，100 ms 的計時器會在 1 秒後才執行。HTML 規範讓巢狀超過 5 層的 `setTimeout` 至少間隔 4 ms；背景分頁的計時器也會被瀏覽器節流（Chrome 至少間隔 1 秒），所以倒數計時不能靠累加 `setInterval` 的次數，要用 `Date.now()` 算。

## long task 與互動延遲

DevTools 的 Performance 分頁把超過 50 ms 的 task 標成 long task：上面畫紅色三角形，超過 50 ms 的部分加上斜線。使用者在 long task 期間點擊或輸入，事件要排在它後面，畫面也要等它結束才更新。Core Web Vitals 的 INP 量的是「互動到下一次畫面更新」的時間，200 ms 以內算良好、超過 500 ms 算差（web-vitals 6.2 的門檻）。

處理 long task 的方法：

| 方法 | 做法 | 限制 |
|---|---|---|
| 切段並讓出主執行緒 | 每處理一批就 `await` 一個 `setTimeout` 或 `scheduler.yield()` | 總時間會變長一點；`scheduler.yield()` 在 Chrome 129、Firefox 142 起支援，Safari 還沒有，要有退回 `setTimeout` 的寫法 |
| 搬進 Web Worker | 計算在另一條執行緒做，用 `postMessage` 傳資料與結果 | Worker 碰不到 DOM；大量資料傳來傳去要複製 |
| 少做一點 | 只算畫面上看得到的、交給後端算、虛擬捲動 | 要改需求或 API |

```js run
// 模擬每筆掛號要做的計算
function summarize(row) {
  let x = 0
  for (let i = 0; i < 3000; i++) x += (row * i) % 7
  return x
}
const rows = Array.from({ length: 50000 }, (_, i) => i)

// 一次跑完：一個很長的 task
let t0 = Date.now()
let total = 0
for (const r of rows) total += summarize(r)
console.log(`一次跑完：${Date.now() - t0} ms 都佔著執行緒`)

// 切成每批 1,000 筆，批與批之間讓出執行緒
const yieldToMain = () => (globalThis.scheduler?.yield ? scheduler.yield() : new Promise((r) => setTimeout(r, 0)))
t0 = Date.now()
total = 0
let longest = 0
for (let i = 0; i < rows.length; i += 1000) {
  const s = Date.now()
  for (const r of rows.slice(i, i + 1000)) total += summarize(r)
  longest = Math.max(longest, Date.now() - s)
  await yieldToMain()          // 這裡讓其他 task（點擊、輸入、渲染）有機會插進來
}
console.log(`切段：總共 ${Date.now() - t0} ms，最長的一段 ${longest} ms`)
```

數字依電腦而定。在主執行緒上，「一次跑完」那段時間點擊與畫面都停住；切段之後，每段之間瀏覽器都能處理事件與渲染，代價是總時間多了一些。

## microtask 也會卡住畫面

microtask queue 要清空才會渲染，一個不斷排新 microtask 的迴圈和 `while (true)` 一樣會卡死頁面：

```js
function loop() { queueMicrotask(loop) }   // 永遠清不空，畫面與所有 task 都停住
```

把一段大計算改寫成一連串的 `then`，並不會讓畫面有機會更新。

0 ms 的計時器要等所有 microtask：

```js run
let ran = 0
const t0 = Date.now()
setTimeout(() => console.log(`setTimeout 0 ms：等了 ${Date.now() - t0} ms，前面跑了 ${ran} 個 microtask`), 0)

// 每個 microtask 再排下一個，共 10 萬個；它們全部跑完，計時器才輪得到
function step() {
  ran++
  if (ran < 100000) queueMicrotask(step)
}
queueMicrotask(step)

await new Promise((r) => setTimeout(r, 100))
```

## 在 Vue 元件裡：先畫「處理中…」，再分批計算

```vue
<script setup>
import { ref, nextTick, useTemplateRef } from 'vue'

const status = ref('待命')
const report = ref(null)
const reportEl = useTemplateRef('report')

// 讓出主執行緒：有 scheduler.yield() 就用，沒有就排一個 task
const yieldToMain = () =>
  globalThis.scheduler?.yield ? scheduler.yield() : new Promise((r) => setTimeout(r, 0))

// 等過一次繪製：rAF 在繪製前執行，裡面排的 setTimeout 在繪製後才輪到
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

async function generate(rows) {
  status.value = '處理中…'
  await nextPaint()                         // 「處理中…」先畫到畫面上

  const result = new Map()
  for (let i = 0; i < rows.length; i += 1000) {
    addToReport(result, rows.slice(i, i + 1000))   // 每批控制在 50 ms 以內
    await yieldToMain()
  }

  report.value = result
  status.value = '完成'
  await nextTick()                          // DOM 更新完才捲動
  reportEl.value?.scrollIntoView({ block: 'start' })
}
</script>
```

`requestAnimationFrame` 在背景分頁不會執行，`nextPaint()` 會等到分頁回到前景才完成。按下按鈕的當下分頁一定在前景，這裡沒問題；排程在背景執行的工作不要用它。

## 其他現象與修法

| 現象或訊息 | 原因 | 修法 |
|---|---|---|
| 按了沒反應，過一陣子才一次反應 | long task 佔住主執行緒，事件排在後面 | 切段、搬進 Worker，或少做一點 |
| Performance 分頁的 task 上有紅色三角形 | 這個 task 超過 50 ms | 點開看 Bottom-Up 或 Call Tree，找出花最多時間的函式 |
| `setTimeout(fn, 0)` 比 `then` 晚執行 | 正常：task 永遠在 microtask 之後 | 需要「這輪結束後馬上做」用 `queueMicrotask` 或 `nextTick` |
| 改完資料的下一行讀 DOM，拿到舊的高度或內容 | Vue 的 DOM 更新排在 microtask，還沒做 | `await nextTick()` 之後再讀 |
| 有人用 `setTimeout(…, 100)` 等 DOM 更新 | 用延遲碰運氣，慢的裝置上會失敗 | 改成 `nextTick` |
| 頁面完全卡死，Chrome 跳出頁面沒有回應的對話框 | 無窮迴圈，或不斷排新 microtask 的遞迴 | 找出迴圈的結束條件 |
| 背景分頁的倒數計時變慢 | 背景分頁的計時器被節流 | 用 `Date.now()` 算剩餘時間；`visibilitychange` 回到前景時重算 |
| `setInterval` 做的動畫一頓一頓 | 計時器和繪製不同步，又會被 long task 擋住 | 用 CSS 動畫或 `requestAnimationFrame` |

## 動手

- 打開 [事件迴圈實驗室](#/lab/EventLoopLab)，逐步執行「基本順序」與「await」兩個範例，每一步先猜 Console 會多出哪一行；切到「長任務」，開關「先讓出主執行緒」，比較畫面上出現過哪些字。
- 按必讀「最小範例」第一段的「在 Playground 開啟」，把 `timeout A` 的延遲改成 10，看順序怎麼變。
- 在「long task 與互動延遲」的切段程式把每批 1,000 筆改成 10,000 筆，看最長的一段變成多少 ms。
- 在任一頁面打開 Performance 分頁，CPU 節流選 `4× slowdown`，錄一次點擊或輸入，找出有紅色三角形的 task 與它呼叫的函式。
- Promise、`async` 與 `await` 的寫法，見 [非同步：Promise 與 async/await](#/skill/async-js)；Vue 的 `nextTick` 與 DOM 的時機，見 [Vue 的生命週期](#/skill/lifecycle)。
