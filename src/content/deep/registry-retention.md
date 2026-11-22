## 儲存空間用了 92%：一萬一千個 tag 從沒刪過

本課接在 [私有映像倉庫：Harbor 的專案、機器人帳號與 CI 推送](#/skill/container-registry) 之後，用同一座院內 Harbor（以 Harbor 2.x 為準，選單位置與欄位名稱以官方文件為準）。儲存空間用了 92%：`clinic/api` 有一萬一千多個 tag，三年來每次合併推一個，從沒刪過，專案上也沒有保留規則。

刪掉 tag 只拿掉名字。沒有 tag 的 manifest 成為 untagged artifact，blob 照樣在磁碟上，要等垃圾回收（garbage collection，GC）把沒有任何 manifest 參照的 blob 刪掉；還被其他映像參照的 layer 不會釋放。所以清理分兩步：保留規則決定刪哪些 tag，垃圾回收才釋放空間。

## 保留規則：只寫要保留什麼

保留規則（tag retention）設在專案上，指定套用的 repository（`**` 是全部），每條規則選一種保留條件，再用 tag 樣式限定範圍：

| 保留條件 | 意思 |
|---|---|
| 最近推送的 N 個、最近拉取的 N 個 | 依推送或最後拉取的時間，數量上限 N |
| N 天內推送的、N 天內拉取的 | 依時間，沒有數量上限 |
| 一律保留 | 通常搭配 `release-*` 這類樣式 |

官方文件描述的幾個行為，第一次設定時常讓人意外：

- 規則只寫要保留什麼，沒被任何一條保留的就刪。規則之間是 OR。
- 「最近 N 個」在每個 repository 各自計算。
- 比對看 tag，刪除以 artifact 為單位：同一個 digest 只要有一個 tag 被保留，其他 tag 一起留下。
- 沒有 tag 的 artifact 預設不在規則範圍內（除非勾選包含 untagged），執行時會被刪。
- 一個專案最多 15 條規則，共用一個排程。執行後無法復原，先 dry run。

## 最小的一組設定與執行順序

`clinic` 專案可以用這一組：`release-*` 一律保留（同時設成不可變）、最近推送的 20 個、30 天內拉取過的。部署端再訂一條規矩：正式環境只部署 release tag，緊急修正事後補打。定期把叢集裡實際在跑的映像（`kubectl get pods -A -o jsonpath='{..image}'`）和 Harbor 比對。

開頭那一萬一千個 tag，第一次清理依序做保留規則 dry run、執行、垃圾回收 dry run、執行；之後排成每週固定時段，保留規則先、垃圾回收後。

| 訊息或現象 | 原因 | 怎麼修 |
|---|---|---|
| 刪了幾千個 tag，磁碟用量幾乎沒變 | 刪 tag 只拿掉名字，blob 要等垃圾回收；被保留的映像共用的層也不會釋放 | 保留規則之後跑垃圾回收；能釋放多少先看 dry run 的估算 |
| 節點故障後重排的 Pod 停在 `ImagePullBackOff` | 正在部署的映像沒有被任何一條規則保留，被刪了 | 正式環境只部署 release tag；定期把叢集裡在跑的映像和 Harbor 比對 |

:::stop 讀到這裡可以先停：知道保留規則只寫要保留什麼、刪完要跑垃圾回收才釋放空間，會替一個專案訂保留規則與執行順序。後面的保留規則模擬、垃圾回收與配額的細節、不可變 tag、弱點掃描與阻擋拉取，在要估能釋放多少空間、保護 release 版本或打開掃描政策時再回來讀。

## 模擬：三條保留規則加一道安全網

Harbor 只知道推送時間、拉取時間與 tag 名稱，不知道哪個映像正在叢集裡跑。節點用 `imagePullPolicy: IfNotPresent` 時，映像拉過一次就用快取，一個跑了兩個月的版本，在 Harbor 看來就是兩個月沒人拉。下面的模擬從 `clinic/api` 挑 12 個代表性的 artifact，套用三條規則，再加一道「部署中的不刪」的安全網，最後算能釋放多少空間：

```python run
from datetime import date
from fnmatch import fnmatch

TODAY = date(2026, 11, 16)
# Harbor 上設定的三條保留規則
KEEP_LATEST = 5            # 最近推送的 N 個
PULLED_WITHIN = 30         # N 天內拉取過的
PATTERNS = ("release-*",)  # 符合這些樣式的 tag 一律保留

# 每一層的大小（MB）。py-* 是 python:3.12-slim 的層，ifx-* 是 Informix 用戶端，
# venv-* 是裝好的依賴，app-* 是程式碼。基底每月重建，這裡只畫 2024 與 2026 兩版
LAYERS = {
    "py-2024": 48, "ifx-2024": 85, "py-2026": 50, "ifx-2026": 88,
    "venv-a": 61, "venv-b": 64, "venv-c": 66,
}

def size(layer):
    return LAYERS.get(layer, 0.4)   # 沒列出的是程式碼層，每層約 0.4 MB

BASE_2024 = ["py-2024", "ifx-2024"]
BASE_2026 = ["py-2026", "ifx-2026"]

# clinic/api 這個 repository 裡的 artifact（一個 digest 可以有好幾個 tag）
artifacts = [
    {"digest": "sha256:a01", "tags": ["9c41e2d0"], "pushed": "2024-01-15", "last_pulled": "2024-01-20",
     "deployed": False, "layers": BASE_2024 + ["venv-a", "app-a01"]},
    {"digest": "sha256:a02", "tags": ["5b7a10fe", "release-1.0.0"], "pushed": "2024-03-02", "last_pulled": "2024-06-30",
     "deployed": False, "layers": BASE_2024 + ["venv-a", "app-a02"]},
    {"digest": "sha256:a03", "tags": ["e18c3b77"], "pushed": "2025-02-10", "last_pulled": "2025-02-11",
     "deployed": False, "layers": BASE_2024 + ["venv-b", "app-a03"]},
    {"digest": "sha256:a04", "tags": ["77d0a9c4", "release-1.3.0"], "pushed": "2025-09-01", "last_pulled": "2025-10-01",
     "deployed": False, "layers": BASE_2024 + ["venv-b", "app-a04"]},
    {"digest": "sha256:a05", "tags": ["c2f81b6a", "release-1.4.0"], "pushed": "2026-08-03", "last_pulled": "2026-08-04",
     "deployed": True, "layers": BASE_2026 + ["venv-c", "app-a05"]},
    # 九月的緊急修正：直接用 commit SHA 部署到正式環境，沒有打 release tag
    {"digest": "sha256:a06", "tags": ["3a9d5e01"], "pushed": "2026-09-10", "last_pulled": "2026-09-11",
     "deployed": True, "layers": BASE_2026 + ["venv-c", "app-a06"]},
]
# 十月、十一月的日常合併：每個 commit 一個 tag，測試環境拉過
for i, (sha, pushed, pulled) in enumerate([
    ("41be0c77", "2026-10-05", "2026-10-05"), ("8f02d9e3", "2026-10-19", "2026-10-20"),
    ("d7a3c510", "2026-10-28", "2026-10-28"), ("0b6e4f21", "2026-11-04", "2026-11-05"),
    ("f93c2a8d", "2026-11-11", "2026-11-12"), ("6e15b0aa", "2026-11-14", None),
]):
    artifacts.append({"digest": f"sha256:b{i:02d}", "tags": [sha], "pushed": pushed, "last_pulled": pulled,
                      "deployed": False, "layers": BASE_2026 + ["venv-c", f"app-b{i:02d}"]})

# base/python-informix 這個 repository 本身也持有基底映像的層
REFERENCED_ELSEWHERE = set(BASE_2024 + BASE_2026)

def days_since(d):
    return (TODAY - date.fromisoformat(d)).days if d else None

def harbor_rules(arts, keep_latest, pulled_within, patterns):
    """回傳 {digest: 保留的理由}。規則之間是 OR；一個 tag 符合，整個 artifact 保留"""
    reasons = {}
    newest = sorted(arts, key=lambda a: a["pushed"], reverse=True)[:keep_latest]
    for a in newest:
        reasons.setdefault(a["digest"], []).append(f"最近推送的 {keep_latest} 個")
    for a in arts:
        age = days_since(a["last_pulled"])
        if age is not None and age <= pulled_within:
            reasons.setdefault(a["digest"], []).append(f"{age} 天前被拉過")
        hit = [t for t in a["tags"] if any(fnmatch(t, p) for p in patterns)]
        if hit:
            reasons.setdefault(a["digest"], []).append(f"tag {hit[0]} 符合")
    return reasons

def plan(arts, keep_latest, pulled_within, patterns):
    reasons = harbor_rules(arts, keep_latest, pulled_within, patterns)
    keep, delete, at_risk = [], [], []
    for a in arts:
        if a["digest"] in reasons:
            keep.append(a)
        elif a["deployed"]:
            keep.append(a)
            at_risk.append(a)      # Harbor 的規則會刪掉它，但它正在跑
        else:
            delete.append(a)
    kept_layers = {l for a in keep for l in a["layers"]} | REFERENCED_ELSEWHERE
    freed = {l for a in delete for l in a["layers"]} - kept_layers
    return reasons, keep, delete, at_risk, freed

reasons, keep, delete, at_risk, freed = plan(artifacts, KEEP_LATEST, PULLED_WITHIN, PATTERNS)

print(f"{'tag':<28} {'推送':<11} {'最後拉取':<11} 結果")
for a in artifacts:
    tags = ",".join(a["tags"])
    if a in at_risk:
        verdict = "保留（安全網：正在部署中，Harbor 的規則會刪）"
    elif a in keep:
        verdict = "保留：" + "、".join(reasons[a["digest"]])
    else:
        verdict = "刪除"
    print(f"{tags:<28} {a['pushed']:<11} {a['last_pulled'] or '從未':<11} {verdict}")

total = sum(size(l) for l in {l for a in artifacts for l in a["layers"]} - REFERENCED_ELSEWHERE)
tag_size = sum(size(l) for a in delete for l in a["layers"])
print(f"\n刪除 {len(delete)} 個 artifact、{sum(len(a['tags']) for a in delete)} 個 tag")
print(f"把每個被刪映像的大小直接相加：{tag_size:.0f} MB（介面上的映像大小加總，會重複計算共用的層）")
print(f"刪 tag 當下釋放：0 MB（layer 還在儲存空間裡，要等垃圾回收）")
print(f"垃圾回收後釋放：{sum(size(l) for l in freed):.1f} MB，來自 {sorted(freed)}")
print(f"這個 repository 自己的層總共 {total:.1f} MB（不含 base 專案共用的基底層）")
```

輸出有三點要看：

- `3a9d5e01` 是九月直接用 commit SHA 部署的緊急修正，三條規則都保不住它。真的刪下去，正式環境照常運作，直到某台節點故障、Pod 重排到沒有快取的節點，才出現 `ImagePullBackOff`。
- `5b7a10fe` 自己不符合任何規則，因為同一個 digest 有 `release-1.0.0` 而一起保留。
- 刪掉 3 個映像，介面上的大小加總是 596 MB，垃圾回收後只釋放 1.2 MB：依賴層還被保留的 release 版本用著，基底層由 `base` 專案持有。

## 垃圾回收與配額

依 Harbor 的文件，垃圾回收的行為：

| 項目 | 行為 |
|---|---|
| 刪什麼 | 不再被任何 manifest 參照的 blob；可以勾選先刪除 untagged artifact |
| dry run | 列出可刪的 blob 並估算能釋放的空間 |
| 保護期 | 最近 2 小時內上傳的 blob 不會被刪，避免刪到正在推送的映像 |
| 執行期間 | 照樣可以推送與拉取（很舊的版本要先切唯讀） |

`clinic/api` 每個版本都帶著 130 MB 左右的基底層，磁碟上只有一份；刪掉一百個舊版本，釋放的多半只有程式碼層與換過版本的依賴層。

### 配額

專案可以設儲存空間上限，預設沒有上限；系統層級的預設配額只套用到之後新建的專案。超過時推送失敗，CI 的錯誤類似：

```text
adding 85.3 MiB of storage resource, which when updated to current usage of 49.9 GiB will exceed the configured upper limit of 50.0 GiB.
```

配額依專案計算，同一個 blob 被兩個專案用到時各算一次，加總可能大於實際磁碟用量。整座 Harbor 的磁碟用量與成長速度仍要另外監控，見 [硬體資源與容量規劃](#/skill/capacity-planning)。

## 不可變 tag

Harbor 預設允許同一個 tag 重複推送，tag 移到新的 artifact，舊的變成 untagged，和 [Docker：image、container、layer](#/skill/docker-basics) 開頭兩台主機的 `latest` 是同一件事。不可變規則（tag immutability）設在專案上，用 repository 與 tag 的樣式比對；符合的 tag 推過一次之後，不能被覆蓋、重新標記或被複製覆寫，它指向的 artifact 也不能刪。再推一次同名的 tag：

```text
Failed to process request due to 'clinic/api:release-1.4.0' configured as immutable.
```

`release-*` 適合設成不可變。每個 commit 的 SHA tag 不要設：不可變的 artifact 刪不掉，保留規則也清不掉，磁碟會一直長。

## 推送之後：自動掃描與阻擋拉取

### 自動掃描

Harbor 內建 Trivy 當預設的弱點掃描器（Clair 在 v2.2 從預設移除，要用可以當外部掃描器接上）。Trivy 要在安裝時啟用：安裝程式加 `--with-trivy`，用 Helm chart 則看 chart 的設定。接著打開專案的「推送時自動掃描」與系統層級的排程全部重掃：推進來那天沒有已知弱點，三個月後可能就有，見 [資安維運](#/skill/security-operations)。

### 有高風險弱點就不准拉

專案設定的「Prevent vulnerable images from running」搭配一個嚴重度：映像有這個等級或更高的弱點時，Harbor 拒絕拉取。打開之前先知道它的效果：

- 擋的是拉取，節點與 CI 一樣被擋。新公告的弱點會讓昨天拉得到的映像今天拉不到；執行中的 Pod 不受影響，節點故障重排時才起不來。
- 沒掃過、掃描失敗或還在掃的映像也拉不到。
- 確認不受影響的弱點加進 CVE allowlist（系統或專案層級），每一筆寫下理由與複查日期。

先開自動掃描、只看報告一段時間，排好處理流程與 allowlist 的審核人，再對正式環境拉取的專案打開阻擋，等級從 Critical 開始。

斷網時，Harbor 的 Trivy 預設從 ghcr.io 下載弱點資料庫的那一步會失敗。`harbor.yml` 的 `trivy` 區段可以設 `skip_update`（資料庫檔自己搬進去）與 `offline_scan`，或用 `db_repository` 指向院內同步好的資料庫。資料庫停止更新時，掃描會一直回報沒有新弱點。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本與工具而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 怎麼修 |
|---|---|---|
| `… configured as immutable.` | 不可變的 tag 不能重推 | 用新的版本號 |
| `… cannot be pulled due to configured policy in 'Prevent images with vulnerability severity of "High" or higher from running.'` | 有該等級以上的弱點；或還沒掃、掃描失敗 | 重建以拉到修補過的基底；不受影響的加進 allowlist |
| `… will exceed the configured upper limit of 50.0 GiB.` | 推送後會超過專案的儲存空間配額 | 先跑保留規則與垃圾回收；確認用量後再調整配額 |
| 設成不可變的 SHA tag 一直累積，保留規則清不掉 | 不可變的 artifact 刪不掉 | 不可變規則只套 `release-*`，每個 commit 的 SHA tag 不設 |

## 動手

1. 執行保留規則的模擬。把 `PATTERNS` 改成 `("release-1.[34]*",)`，看垃圾回收多釋放哪一層；再把 `REFERENCED_ELSEWHERE` 改成空集合（假設 `base` 專案也清掉了 2024 年的基底），先預測再執行。
2. 做本課的程式題：[模擬 Harbor 的保留規則，並估算垃圾回收後釋放的空間](#/exercise/container-registry-1)。
3. 替院內 Harbor 的每個專案寫下保留規則、垃圾回收排程與配額，標出哪些 tag 樣式設成不可變。
4. 列出叢集裡實際在跑的映像（`kubectl get pods -A -o jsonpath='{..image}'`），逐一確認它在 Harbor 上會被哪一條保留規則留下。
