## Lighthouse 0 個錯誤的選單，鍵盤打不開

預約清單每一列右邊有一顆「更多操作」，按下去出現「改期」「列印掛號單」「取消預約」三項。這個元件是請 AI 產生的，標記看起來很完整：

```html
<button type="button" aria-haspopup="menu" aria-expanded="false" @click="open = !open">更多操作</button>
<ul v-show="open" role="menu" aria-label="更多操作">
  <li role="menuitem" @click="reschedule">改期</li>
  <li role="menuitem" @click="print">列印掛號單</li>
  <li role="menuitem" @click="cancel">取消預約</li>
</ul>
```

Lighthouse 的 Accessibility 項目沒有報任何錯，用 `@axe-core/playwright` 掃也是 0 個違規。換成只用鍵盤操作：

1. Tab 到「更多操作」按 Enter，選單出現了，焦點還停在按鈕上。
2. 按 ↓，頁面往下捲了一段，選單裡沒有任何一項被反白。
3. 按 Tab，焦點跳過整個選單，直接到下一列；選單還開著。
4. 按 Esc 沒有反應。
5. 用 Elements 分頁看按鈕，選單開著時 `aria-expanded` 仍然是 `"false"`。

axe 檢查的是結構：角色的父子關係、屬性值合不合法、有沒有名稱。它不按鍵盤，也不知道 `aria-expanded` 該在什麼時候變。

## 運作原理：把 APG 的模式頁改寫成驗收表

寫下 `role="menu"` 等於承諾寫好了選單該有的鍵盤操作，ARIA 角色不會讓瀏覽器提供任何鍵盤行為（APG：「A role is a promise」）。該有哪些操作，查 WAI-ARIA Authoring Practices Guide（APG）模式頁固定的兩節：

- **Keyboard Interaction**：每一列是「焦點在哪裡時，按什麼鍵，會發生什麼」。標了 Optional 的是選用行為。
- **WAI-ARIA Roles, States, and Properties**：用哪些角色、哪些屬性要跟著狀態改變、名稱從哪裡來。

把這兩節改寫成「按鍵、焦點去哪、屬性變成什麼」，就是驗收表。Menu Button 模式：

| 起點 | 按鍵 | 焦點去哪 | 屬性 |
|---|---|---|---|
| 按鈕 | Enter、Space | 選單第一項 | 按鈕 `aria-expanded="true"` |
| 按鈕 | ↓（選用） | 選單第一項 | 同上 |
| 按鈕 | ↑（選用） | 選單最後一項 | 同上 |
| 選單項目 | ↓、↑ | 下一項、上一項（到頭時可以繞回） | 不變 |
| 選單項目 | Home、End | 第一項、最後一項（APG 寫在方向鍵不繞回的情況） | 不變 |
| 選單項目 | Enter | 執行這一項、關閉選單 | `aria-expanded="false"` |
| 選單項目 | Esc | 關閉選單，焦點回到按鈕 | `aria-expanded="false"` |
| 選單項目 | Tab | 關閉選單，焦點照常移到頁面上的下一個元素 | `aria-expanded="false"` |

標 Optional 的列先決定做不做，寫進規格。每一列都是一個能自動化的測試。

## 整組只佔一個 Tab 停留點，裡面用方向鍵

Tab 在元件之間移動，方向鍵在元件裡面移動。Tabs、Menu、Listbox 這類元件整組在 Tab 順序裡只有一個位置，裡面的焦點有兩種做法：

```text
roving tabindex（Tabs、Menu、Radio group 常用）
  <button role="tab" tabindex="-1">預約</button>
  <button role="tab" tabindex="0">已報到</button>   ← 目前的項目；document.activeElement 就是它
  <button role="tab" tabindex="-1">已取消</button>
  按 → ：已報到改成 -1，已取消改成 0，呼叫 已取消.focus()

aria-activedescendant（Combobox 常用）
  <input role="combobox" aria-activedescendant="doc-3">   ← DOM 焦點一直在這裡
  <ul role="listbox">
    <li id="doc-1" role="option">王醫師</li>
    <li id="doc-3" role="option">林醫師</li>              ← 輔助科技視為目前的項目，畫面要畫出反白
  按 ↓ ：只改 aria-activedescendant 的值，DOM 焦點不動
```

從元件前一個元素連按 Tab，每個選單項目都停一次，代表沒照模式做。

## 照驗收表寫的 Menu Button，與兩個最常見的錯誤

```vue
<script setup>
import { ref, useTemplateRef, nextTick, useId } from 'vue'

const props = defineProps({ items: { type: Array, required: true } })   // [{ key, label }]
const emit = defineEmits(['select'])
const open = ref(false)
const current = ref(0)
const button = useTemplateRef('button')
const itemEls = useTemplateRef('item')       // v-for 裡的 ref 是陣列
const uid = useId()                           // Vue 3.5：產生穩定的 id，給 aria-controls 用

async function openMenu(index) {
  open.value = true
  current.value = index
  await nextTick()                            // 等 v-show 讓選單出現，才能 focus()
  itemEls.value[index].focus()
}
function closeMenu({ restoreFocus = true } = {}) {
  open.value = false
  if (restoreFocus) button.value.focus()
}
function onButtonKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(0) }
  if (e.key === 'ArrowUp') { e.preventDefault(); openMenu(props.items.length - 1) }
}
function onMenuKeydown(e) {
  const n = props.items.length
  const moves = { ArrowDown: current.value + 1, ArrowUp: current.value - 1, Home: 0, End: n - 1 }
  if (e.key in moves) {
    e.preventDefault()                        // 方向鍵不要捲動頁面
    current.value = (moves[e.key] + n) % n    // 到頭時繞回
    itemEls.value[current.value].focus()
  } else if (e.key === 'Escape') {
    closeMenu()
  } else if (e.key === 'Tab') {
    closeMenu({ restoreFocus: false })        // 不 preventDefault：讓 Tab 照常移到下一個元素
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    choose(current.value)
  }
}
function choose(i) {
  closeMenu()                                 // 先把焦點還給按鈕，再通知父元件（父元件可能接著開 Dialog）
  emit('select', props.items[i].key)
}
</script>

<template>
  <button ref="button" :id="`${uid}-btn`" type="button" aria-haspopup="menu"
          :aria-expanded="open ? 'true' : 'false'" :aria-controls="`${uid}-menu`"
          @click="open ? closeMenu() : openMenu(0)" @keydown="onButtonKeydown">
    更多操作
  </button>
  <ul v-show="open" :id="`${uid}-menu`" role="menu" :aria-labelledby="`${uid}-btn`" @keydown="onMenuKeydown">
    <li v-for="(it, i) in items" :key="it.key" ref="item" role="menuitem" tabindex="-1" @click="choose(i)">
      {{ it.label }}
    </li>
  </ul>
</template>
```

Enter 與 Space 在原生 `<button>` 上本來就會觸發 `click`，所以按鈕只需要另外處理 ↓ 與 ↑。axe 對下面兩個錯誤沒有訊息：

- **`aria-expanded` 寫死**：`aria-expanded="false"` 寫成靜態屬性，開關時不變。Elements 分頁一邊按一邊看；測試裡斷言開啟後是 `"true"`。
- **選單項目沒有 `tabindex="-1"`**：`li` 不能被 `focus()`，呼叫了也沒效果，焦點留在原地。Testing Library 的訊息會是 `expect(element).toHaveFocus()` 失敗，列出目前有焦點的元素。

:::stop 讀到這裡可以先停：會把 APG 的模式頁改寫成驗收表，用 roving tabindex 做出鍵盤能操作的 Menu Button。後面是兩種焦點方法的比較、各模式的驗收重點、每種工具抓得到什麼、Dialog 的焦點回復、元件測試與 Playwright 的寫法，實作或審查一個具體的選單、Tabs 時再回來讀。

## role 是承諾：沒兌現比不寫更糟

APG 的 Read Me First 把 ARIA 角色稱為承諾。按鈕宣告選單已收合時，按 Enter 應開啟選單，讓使用者能用方向鍵在選項間移動。ARIA 屬性本身只提供語意。Menu Button 的標記如下。

- 按鈕是 `button`（原生 `<button>` 就好），有 `aria-haspopup`（值是 `menu` 或 `true`）；`aria-controls` 指向選單是選用的。
- 選單是 `role="menu"`，名稱來自 `aria-labelledby` 指向按鈕，或 `aria-label`。
- 每一項是 `menuitem`，用 roving tabindex 時 `tabindex="-1"`。

## composite widget：Tab 進入時停在哪一項

APG 的 Developing a Keyboard Interface 說明這類 composite widget 的共用慣例。Tab 在元件之間移動，方向鍵在元件內移動。

| 元件 | Tab 進入時的焦點 |
|---|---|
| Tabs、Listbox、Radio group | 目前選取（勾選）的那一項；沒有就第一項 |
| Grid | 上一次離開時的那一格；第一次進入是第一格 |
| Menubar、Toolbar | 第一項 |
| Menu（由按鈕開出來） | Tab 不會進入選單，開選單時由程式把焦點移進去 |

若 Tab 停在每一項，檢查整組是否都是原生按鈕或 `tabindex="0"`。

## roving tabindex 與 aria-activedescendant 的差別

| | roving tabindex | `aria-activedescendant` |
|---|---|---|
| `document.activeElement` | 跟著方向鍵換人 | 一直是容器或輸入框 |
| 要檢查的屬性 | 只有一項是 `tabindex="0"` | 屬性值有沒有換、指到的 id 存不存在 |
| 捲動 | 瀏覽器會把取得焦點的元素捲進畫面 | 程式要自己捲動 |
| 反白樣式 | 用 `:focus-visible` | 程式自己加 class，焦點框不會自動出現 |

`aria-activedescendant` 應指向 DOM 子代或由 `aria-owns` 擁有的元素。Combobox 可透過 `aria-controls` 指向含該選項的清單。

## 焦點與選取是兩件事

焦點是 `document.activeElement`。選取狀態如 `aria-selected="true"` 或 `aria-checked="true"`，離開元件後仍會保留。單選 Tabs 和 Listbox 可讓選取跟著焦點，也可 [手動切換](#/skill/navigation-ui)。分別測兩個狀態。

## 各模式的驗收重點

| 模式 | 焦點方法 | 一定要測的按鍵 | 一定要查的屬性 | 完整規則 |
|---|---|---|---|---|
| Tabs | roving tabindex | Tab 只停目前的 tab；←→ 繞回；再按 Tab 進入 tabpanel | 只有一個 `aria-selected="true"`；`aria-controls` 與 tabpanel 的 `aria-labelledby` 互相對得到 | [導覽元件](#/skill/navigation-ui) |
| Menu Button | roving tabindex | Enter 開選單焦點到第一項；Esc 關閉焦點回按鈕；Tab 關閉 | `aria-expanded` 跟著開關；menu 有名稱 | 本課 |
| Combobox | `aria-activedescendant` | ↓ 開清單；Enter 選取；Esc 關清單、保留值 | `aria-expanded`；`aria-activedescendant` 指到存在的 option | [選擇類元件](#/skill/select-combobox) |
| Dialog（modal） | 焦點移進 Dialog | Tab 不會走到背景；Esc 關閉；焦點回到觸發的按鈕 | Role 是 `dialog`、Name 是標題 | [浮層](#/skill/overlays) |
| Disclosure、Accordion | 每顆按鈕都在 Tab 順序裡 | Enter、Space 切換 | `aria-expanded` 跟著切換；Accordion 的按鈕包在標題元素裡 | 本課 |

Disclosure 用按鈕切換內容，`aria-controls` 可指向內容。Accordion 的每顆按鈕是標題元素的唯一子元素，方便螢幕閱讀器依標題瀏覽。客製行為用原生按鈕保留 Tab 操作。

一般情況用 [原生 `<details>` 與 `<summary>`](#/skill/semantic-html)（Baseline Widely available）。同組設 `name="faq"` 可限制同時只開一項（Baseline 2024，自 2024-09 起），舊版可同時展開多項。驗收 `<summary>` 的朗讀文字與標題層級。

## 每種工具抓得到什麼

| 工具 | 抓得到 | 抓不到 |
|---|---|---|
| Lighthouse、axe（`@axe-core/playwright`） | 角色的父子關係錯誤、屬性值不合法（包含指到不存在的 id）、缺少必要屬性、缺少名稱 | 按鍵有沒有作用、屬性有沒有跟著狀態改變、焦點去哪 |
| DevTools 的 Accessibility 分頁 | 某個元素此刻的 Role、Name、狀態；整棵 accessibility tree | 操作過程中的變化（要自己一邊按一邊看） |
| 元件測試（jsdom 加 user-event） | 按鍵後的焦點、`aria-*` 的值、emit 的事件 | `<dialog>` 的 `showModal()`、top layer、版面、捲動 |
| Playwright、Vitest Browser Mode | 上面全部，加上真的 `<dialog>`、焦點回復、可見性 | 念出來聽不聽得懂 |
| NVDA、VoiceOver 實測 | 角色、名稱、狀態變化念出來的樣子，跨元件的操作流程 | 不會留下可以重跑的紀錄 |

## Menu Button 的細節：aria-expanded 的綁定、Popover、Dialog 的焦點回復

Vue 3 把綁定的 `false` 輸出成 `aria-expanded="false"`，要移除屬性時綁 `null`。選單可用 `<ul popover>` 取代 `v-show`，取得點外關閉與 top layer（Baseline 2025-01）。

- 呼叫 `showPopover()`、`hidePopover()`，在 `toggle` 更新 `aria-expanded` 並移動焦點。
- 方向鍵、Home、End 仍須自行處理。Modern Web Guidance 建議的 `focusgroup` 從 Chrome、Edge 150 起支援（Limited availability）。
- iOS Safari 18.3 在 2025-01 補齊 Popover，較舊版本可沿用 `v-show`，或偵測 `HTMLElement.prototype` 上的 `popover` 後按需載入 `@oddbird/popover-polyfill`。

若 `choose()` 先 `emit`，父元件呼叫 `showModal()` 時會記住目前的選單項目。接著選單隱藏，背景進入 inert，`button.focus()` 無效。關閉時焦點掉到 `body`，下次 Tab 從頁首開始。先呼叫 `closeMenu()` 把焦點還給按鈕，再 `emit` 開 Dialog。

## 元件測試：一列驗收表一個斷言

```js
// src/components/__tests__/MoreActions.spec.js
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import MoreActions from '../MoreActions.vue'

const items = [
  { key: 'reschedule', label: '改期' },
  { key: 'print', label: '列印掛號單' },
  { key: 'cancel', label: '取消預約' },
]

describe('MoreActions：APG 的 Menu Button 模式', () => {
  it('Enter 開選單、焦點到第一項；↑ 繞到最後一項；Esc 關閉並回到按鈕', async () => {
    const user = userEvent.setup()
    render(MoreActions, { props: { items } })
    const btn = screen.getByRole('button', { name: '更多操作' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')

    await user.tab()                                   // 從頁面開頭 Tab 進來
    await user.keyboard('{Enter}')
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: '改期' })).toHaveFocus()

    await user.keyboard('{ArrowUp}')                   // 第一項再往上：繞到最後一項
    expect(screen.getByRole('menuitem', { name: '取消預約' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(btn).toHaveFocus()
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()   // v-show 隱藏的元素不在 accessibility tree
  })

  it('按鈕上按 ↑ 聚焦最後一項，Enter 選取並 emit', async () => {
    const user = userEvent.setup()
    const { emitted } = render(MoreActions, { props: { items } })
    await user.tab()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: '取消預約' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(emitted().select).toEqual([['cancel']])
    expect(screen.getByRole('button', { name: '更多操作' })).toHaveFocus()
  })
})
```

Testing Library 的 `queryByRole` 預設排除由 `display: none`、`hidden` 或 `aria-hidden="true"` 隱藏的元素。jsdom 31 的 Dialog 沒有 `showModal()`，`choose()` 的焦點回復要在瀏覽器測。

## Playwright：跨元件的焦點回復

```js
// e2e/appointment-actions.spec.js
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('從選單取消預約：Esc 關掉 Dialog 後焦點回到「更多操作」', async ({ page }) => {
  await page.goto('/appointments')
  const more = page.getByRole('button', { name: '更多操作' })
  await more.focus()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('menuitem', { name: '取消預約' })).toBeFocused()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog', { name: '取消 11/20 09:00 的預約？' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '保留預約' })).toBeFocused()   // autofocus
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(more).toBeFocused()
})

test('Tabs 的結構', async ({ page }) => {
  await page.goto('/appointments')
  await expect(page.getByRole('tablist', { name: '掛號狀態' })).toMatchAriaSnapshot(`
    - tablist "掛號狀態":
      - tab "預約" [selected]
      - tab "已報到"
      - tab "已取消"
  `)
})

test('axe：選單打開的狀態也掃一次', async ({ page }) => {
  await page.goto('/appointments')
  await page.getByRole('button', { name: '更多操作' }).click()
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  expect(results.violations).toEqual([])
})
```

`toMatchAriaSnapshot` 比對 accessibility tree 的角色、名稱與狀態（如 `[selected]`）。用 axe 檢查選單、Dialog 或錯誤訊息時，先操作到該狀態。

## axe 的錯誤訊息

axe（Lighthouse 也用它）對常見結構錯誤的訊息，左欄是規則 id，下面的訊息取自 axe-core 4.14.1 的實際輸出：

| 規則 | 訊息 | 原因 |
|---|---|---|
| `aria-required-parent` | `Certain ARIA roles must be contained by particular parents`，細節 `Required ARIA parent role not present: tablist` | `role="tab"` 沒有包在 `role="tablist"` 裡 |
| `aria-required-children` | `Certain ARIA roles must contain particular children`，細節 `Element has children which are not allowed: li` | `role="menu"` 底下有沒標 `menuitem` 的 `li` |
| `aria-valid-attr-value` | `ARIA attributes must conform to valid values`，細節 `Invalid ARIA attribute value: aria-activedescendant="doc-9"` | 指到不存在的 id；`aria-selected="yes"` 這種不合法的值也是這條 |
| `aria-required-attr` | `Required ARIA attributes must be provided`，細節 `Required ARIA attribute not present: aria-checked` | `role="switch"` 沒有 `aria-checked` |
| `aria-dialog-name` | `ARIA dialog and alertdialog nodes should have an accessible name` | Dialog 沒有 `aria-labelledby` 或 `aria-label` |

## axe 沒有訊息、要靠測試或手動抓的錯誤

- **每個 tab 都是 `tabindex="0"`**：Tab 鍵要一格一格走過每個 tab。測試裡 `await user.tab()` 兩次，第二次焦點應該已經在 tabpanel。
- **方向鍵沒有 `preventDefault()`**：按 ↓ 時焦點移到下一項，頁面也跟著捲一段。
- **焦點回到 `body`**：觸發的元素被隱藏或移除。Playwright 的訊息是：

```text
Error: expect(locator).toBeFocused() failed

Locator:  getByRole('button', { name: '更多操作' })
Expected: focused
Received: inactive
```

  在 Console 建立 live expression `document.activeElement`，一步一步操作，就能看到它在哪一步變成 `body`。

- **`role="menu"` 用在網站導覽**：一般的導覽列用連結加 disclosure 按鈕（見 [導覽元件](#/skill/navigation-ui)）。寫成 menu，螢幕閱讀器使用者會照應用程式選單的方式操作，Tab 卻又走得進去。
- **自動化全綠就收工**：axe、元件測試都過了，仍然要用 NVDA 或 VoiceOver 念一遍。APG 的 Read Me First 也提醒，各瀏覽器與螢幕閱讀器的支援程度不同，上線前要在目標使用者會用的組合上實測。

## 動手

1. 把選單、Tabs 或手風琴的 APG 規則寫成驗收表，標出採用的選配行為。用 `document.activeElement` 和 DevTools 的 accessibility tree 核對焦點、父子角色與 Name。
2. 跑 Lighthouse，再用 `@axe-core/playwright` 分別掃描開啟的選單和 Dialog，比較結果。
3. 用 [Testing Library 與 user-event](#/skill/component-tests) 測按鍵和屬性，並用 [Playwright](#/skill/e2e-playwright) 測 Dialog 焦點回復。移除 `focus()` 或 `aria-expanded` 綁定後重跑，確認測試能抓到。
4. 開 VoiceOver（macOS 按 Cmd+F5）或 NVDA 操作選單，確認名稱和「已展開」等狀態有念出來。見 [無障礙基礎](#/skill/a11y-basics)。
