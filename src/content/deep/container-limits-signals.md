## 每次更新都等 10 秒，切斷兩筆交易

本課接在 [容器的日常維運：查問題、結束碼與日誌](#/skill/container-operations) 之後，用同一套批價繳費系統。`payment-socket` 讓繳費機與刷卡機用長連線連進來，主行程是 `python payment_server.py`。每次更新它都停在 `Stopping` 約 10 秒；週四更新後，有兩筆刷卡交易逾時，要人工和銀行對帳。`docker events` 顯示 SIGTERM 送出 10 秒後 Docker 改送 SIGKILL，結束碼 137，`OOMKilled` 是 `false`。一次更新的經過：

| 時間 | 事件 |
|---|---|
| 0 秒 | `docker stop`（`compose up -d` 換新版時也一樣）送 SIGTERM 給 PID 1 |
| 0 到 10 秒 | `payment_server.py` 沒有註冊 SIGTERM 的處理函式；它是 PID 1，訊號被忽略，程式照常接新交易 |
| 10 秒 | 寬限期到，Docker 送 SIGKILL；每條連線上做到一半的交易一起中斷，結束碼 137 |
| 10 秒之後 | 新容器啟動，繳費機與刷卡機重新連線 |

## `--init` 只解決一半：程式要自己處理 SIGTERM

`docker run --init`（compose 寫 `init: true`）讓 Docker 內建的 tini 當 PID 1，`payment_server.py` 變成它的子行程。tini 把訊號轉給子行程，也回收結束的子孫行程（避免殭屍行程）。加上之後 `docker stop` 會立刻完成：Python 不再是 PID 1，收到 SIGTERM 就用預設動作當場結束，結束碼 143。手上的交易一樣被切斷，只是從「等 10 秒再切」變成「立刻切」。

所以程式本身要處理 SIGTERM。`--init` 仍然值得加：程式開的子行程有人回收，之後某個沒處理訊號的程式也不會每次等滿寬限期。

## 最小的 SIGTERM 處理

收到 SIGTERM 後：停止接新連線、讓每條連線把手上的交易做完、關閉並結束。`handle_one(conn)` 代表既有的「讀一筆交易、處理、回覆」：

```python
# payment_server.py 的關機骨架
# handle_one(conn)：等下一筆交易的開頭最多 1 秒（沒有就丟 socket.timeout）；
#                   讀到開頭之後把整筆做完、回覆，才回傳；對方關閉連線時回傳 False
import signal
import socket
import sys
import threading
import time

DRAIN_SECONDS = 20             # 最多等手上的交易 20 秒；要小於 docker stop -t 與 terminationGracePeriodSeconds
stopping = threading.Event()

def on_term(signum, frame):
    stopping.set()             # 處理函式只設旗標，關機的工作在主迴圈做

signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGINT, on_term)       # 本機按 Ctrl-C 也走同一條路

def serve(conn):
    with conn:
        while not stopping.is_set():        # 每筆交易之間檢查一次：關機中就不收下一筆
            try:
                if not handle_one(conn):
                    return
            except socket.timeout:
                continue                    # 這一秒沒有交易進來，回去檢查旗標
        # 走到這裡時手上沒有交易：在交易之間關閉連線，終端機會重連到新的容器

srv = socket.create_server(("0.0.0.0", 9100))
srv.settimeout(1.0)            # accept 每秒醒來一次，才看得到旗標
workers = []
while not stopping.is_set():
    try:
        conn, _ = srv.accept()
    except socket.timeout:
        continue
    t = threading.Thread(target=serve, args=(conn,), daemon=True)
    t.start()
    workers = [w for w in workers if w.is_alive()] + [t]

srv.close()                    # 1. 停止接新連線
deadline = time.monotonic() + DRAIN_SECONDS
for t in workers:              # 2. 等每條連線把手上的交易做完
    t.join(max(0, deadline - time.monotonic()))
busy = sum(t.is_alive() for t in workers)
print(f"shutdown: {busy} connection(s) still busy after {DRAIN_SECONDS}s", file=sys.stderr, flush=True)
sys.exit(0 if busy == 0 else 1)             # 3. 結束；有沒做完的就以 1 結束，留下紀錄
```

- **`accept` 要設逾時**：Python 3.5 起，系統呼叫被訊號打斷後會自動重試（PEP 475），處理函式跑完 `accept()` 繼續等，主迴圈要等到下一條連線進來才看得到旗標。
- **處理函式只設旗標**：它只在主執行緒執行，可能在任何一行之間被呼叫，在裡面關 socket、等執行緒容易出錯。
- **執行緒設成 `daemon=True`**：等滿 `DRAIN_SECONDS` 還沒做完的，`sys.exit` 時直接結束；非 daemon 的執行緒會讓行程卡住，直到被 SIGKILL。
- **長連線由伺服器在交易之間關閉**：從負載平衡或 Service 的後端移除只影響新連線，已經連著的終端機不會自己斷開。

終端機那一端要能重連並重送。送出後沒等到回覆的交易，重送前先用交易編號查詢結果，避免重複扣款，見 [付款請求的冪等與重試](#/scenario/idempotency)。

`docker stop -t`（compose 的 `stop_grace_period`，Docker 預設 10 秒）要比程式的 `DRAIN_SECONDS` 長，否則做到一半的交易還是被 SIGKILL 切斷。

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `docker stop` 每次剛好 10 秒，`Exited (137)`，`OOMKilled=false` | PID 1 沒有處理 SIGTERM | 程式處理 SIGTERM；`-t` 設得比程式的等待上限長 |
| 加了 `--init` 後立刻停止，`Exited (143)`，交易照樣中斷 | 子行程收到 SIGTERM 用預設動作直接結束 | 程式自己處理 SIGTERM |

:::stop 讀到這裡可以先停：知道 `docker stop` 先送 SIGTERM、等滿寬限期再送 SIGKILL，會替 PID 1 的 Python 服務補上 SIGTERM 處理。後面的各層寬限期、四種關機方式的模擬、記憶體與 CPU 上限、重啟策略，在 `docker stop` 還是切斷請求、容器 OOM 或一直重啟時再回來讀。

## 寬限期由內而外

同一套系統的 `billing-api` 是 Flask 後端：產生收據 PDF（cairo、pango），主行程是 `gunicorn -w 1 --threads 50 --keep-alive 75 …`。

| 層 | 設定 | 這個系統 |
|---|---|---|
| 程式 | `DRAIN_SECONDS`；gunicorn 的 `--graceful-timeout`（預設 30 秒） | `payment-socket` 20 秒；`billing-api` 30 秒 |
| 容器 | `docker stop -t`、`docker run --stop-timeout`、compose 的 `stop_grace_period`（Docker 預設 10 秒） | 比程式的長：`payment-socket` 30 秒、`billing-api` 35 秒 |
| Kubernetes | `terminationGracePeriodSeconds`（預設 30 秒），有 `preStop` 時從 preStop 開始就算在裡面 | 同樣比程式的長，再加上 preStop 的秒數 |

`billing-api` 的 gunicorn 會處理 SIGTERM，但 Docker 預設只等 10 秒，比 gunicorn 的 30 秒短，較久的 PDF 請求一樣被切斷。Dockerfile 的 `STOPSIGNAL` 可以改 `docker stop` 送的訊號，官方 nginx 映像就用它改成 SIGQUIT（nginx 的優雅關機）。

`docker compose up -d` 換新版時先停舊容器再起新的，中間沒有人接交易，終端機一定要會重試。Kubernetes 的滾動更新可以先起新 Pod 再停舊的，preStop 與寬限期見 [Kubernetes 實作：設定、探針與資源](#/skill/k8s-config-probes) 的優雅關機段落。

## 模擬：四種關機方式各切斷幾筆交易

下面把開頭那次更新寫成事件序列：t=0 送出 SIGTERM，六筆交易各有開始時間與需要的秒數。

```python run
# 付款服務在 t=0 收到 SIGTERM。每筆交易：(編號, 終端機, 開始時間, 需要幾秒)
# 時間以 SIGTERM 為 0；負的表示 SIGTERM 之前就開始了
TX = [
    ("T1", "繳費機-3", -3.0, 4.0),
    ("T2", "櫃檯-1", -1.5, 6.0),
    ("T3", "繳費機-7", -0.5, 12.0),   # 等銀行回應比較久
    ("T4", "繳費機-3", 2.0, 3.0),     # 已經連著的終端機送來下一筆
    ("T5", "櫃檯-2", 5.0, 2.0),       # 新的連線
    ("T6", "櫃檯-1", 8.0, 4.0),
]

def stop(title, handles_sigterm, init=False, drain=20, grace=10):
    """handles_sigterm：程式有沒有處理 SIGTERM；init：PID 1 是不是 tini（--init）
    drain：程式自己最多等幾秒；grace：docker stop -t（Kubernetes 是 terminationGracePeriodSeconds）"""
    if not handles_sigterm and init:
        # tini 把 SIGTERM 轉給 python；python 沒有處理函式，用預設動作當場結束
        end, accept_until, code = 0.0, 0.0, 143
    elif not handles_sigterm:
        # python 是 PID 1，SIGTERM 被忽略：照常接交易，寬限期到了被 SIGKILL
        end, accept_until, code = grace, grace, 137
    else:
        accept_until = 0.0                            # 收到 SIGTERM 就不再收新交易
        busy_until = max((s + d for _, _, s, d in TX if s < 0 < s + d), default=0.0)
        end = min(busy_until, drain)                  # 做完手上的，或等滿 drain 就放棄
        code = 0 if busy_until <= drain else 1
        if end >= grace:                              # 寬限期先到：SIGKILL
            end, code = grace, 137
    done, cut, retry = [], [], []
    for tid, term, start, dur in TX:
        if start >= 0 and start >= accept_until:
            retry.append(tid)                         # 沒有被收下：終端機要重新連線再送
        elif start + dur <= end:
            done.append(tid)
        else:
            cut.append(tid)                           # 做到一半被中斷
    print(title)
    print(f"  第 {end:4.1f} 秒結束，結束碼 {code}")
    print(f"  完成 {done}　被切斷 {cut}　要重送 {retry}\n")

stop("A. 沒處理 SIGTERM（python 是 PID 1）", handles_sigterm=False)
stop("B. 沒處理 SIGTERM，加了 --init", handles_sigterm=False, init=True)
stop("C. 處理 SIGTERM，docker stop -t 30", handles_sigterm=True, grace=30)
stop("D. 處理 SIGTERM，寬限期用預設的 10 秒", handles_sigterm=True, grace=10)
```

A 是開頭的狀況：T3 與 T6 被切斷，正好兩筆，其中 T6 是 SIGTERM 之後才收下的。B 停得最快，切斷的反而最多。C 多花 1.5 秒，沒有交易被切斷，T4 到 T6 由終端機重送到新容器。D 的程式寫對了，寬限期卻比最長的交易短，T3 還是被切斷；結束碼 137 和 A 一樣，只看結束碼分不出這兩種情況。

## 資源上限：記憶體、CPU 與 GIL

```bash
docker run -d --name billing-api --memory 1g --memory-swap 1g --cpus 2 harbor.example.org/billing/api:4.12.0
docker update --memory 1g --memory-swap 1g --cpus 2 billing-api    # 執行中的容器直接改，不用重建
```

| 參數 | 作用 | 注意 |
|---|---|---|
| `--memory` | cgroup 的記憶體上限 | 沒設時可以用到整台主機；一個容器洩漏，主機的 OOM killer 可能挑中別的行程 |
| `--memory-swap` | 記憶體加 swap 的總量 | 只設 `--memory`、主機又有 swap 時，容器還能再用同樣大小的 swap；變慢比被砍更難察覺。設成和 `--memory` 一樣就不用 swap |
| `--cpus` | 每段時間最多用幾顆核心的 CPU 時間 | 超過被節流，變慢但不會被砍 |

### 超過記憶體上限

核心的 OOM killer 在容器的 cgroup 裡挑一個行程，送 SIGKILL。被挑中的是誰，結果不一樣：

| 被殺的是 | 容器 | 看得到的線索 |
|---|---|---|
| PID 1（例如 `payment_server.py`） | 結束，`Exited (137)`；有重啟策略就被拉起來 | `docker inspect` 的 `OOMKilled` 是 `true`；`docker events` 有 `oom` 與 `die` |
| 子行程（例如 gunicorn 的 worker） | 不會結束，gunicorn master 重開一個 worker | gunicorn 的 log：`Worker (pid:…) was sent SIGKILL! Perhaps out of memory?`；`docker events` 有 `oom`；`docker ps` 看起來一切正常 |

`billing-api` 是 `-w 1`：唯一的 worker 被砍時，它手上 50 個執行緒的請求全部中斷（nginx 回 502），新 worker 起來前沒有人處理請求。

Kubernetes 1.28 起，cgroup v2 的節點上只要容器裡有一個行程觸發 OOM，整個容器一起被砍，同一個 gunicorn 會看到容器 `OOMKilled`、重啟次數加一；1.32 起 kubelet 的 `singleProcessOOMKill` 設定可以改回只砍單一行程。行為依版本而定，以官方文件為準。

### Python 的記憶體為什麼會慢慢長

`docker stats` 看到記憶體一天比一天高、重啟後歸零再慢慢爬，常見原因：

- **沒有上限的快取**：模組層級的 dict、`lru_cache(maxsize=None)`、一直 append 的全域清單。
- **大物件乘上並行數**：一份 PDF 在記憶體裡組好再送出，50 個執行緒同時產生就是 50 份。高峰被撐高，但到頂就平，不是洩漏。
- **記憶體沒有還給作業系統**：釋放的物件，記憶體常留在行程裡給之後重用（Python 的配置器與 glibc 的 malloc 都會保留）。執行緒多時 glibc 會開多個配置區（arena），碎片更多；環境變數 `MALLOC_ARENA_MAX` 可以限制數量，效果要量測。
- **原生函式庫的洩漏**：C 程式庫沒有釋放，`tracemalloc` 看不到。

曲線一路往上不回落是洩漏，到某個高度就平是上限太小或並行太高。`tracemalloc` 取兩個時間點的快照比較，找得到 Python 層是哪一行在累積。修好之前，gunicorn 的 `--max-requests` 加 `--max-requests-jitter` 讓 worker 定期重開（見 [應用伺服器與程序管理](#/skill/process-servers)）。

### CPU：threads 與 GIL

`-w 1 --threads 50` 是一個行程、50 個執行緒。等資料庫、等印表機時執行緒會釋放 GIL，可以同時等；產生 PDF 的排版運算如果大部分在 Python 層，同一時間只有一個執行緒在跑，CPU 卡在一顆核心左右：

```bash
$ docker stats --no-stream billing-api
CONTAINER ID   NAME          CPU %     MEM USAGE / LIMIT   MEM %     NET I/O         BLOCK I/O      PIDS
7f3e2a91c0d7   billing-api   101.36%   812MiB / 1GiB       79.30%    1.2GB / 3.4GB   45MB / 2.1GB   53
```

上限是 `--cpus 2`（200%），CPU 卻停在 100% 左右、請求在排隊，調高 `--cpus` 不會有幫助。`PIDS` 的 53 是 master、worker 與它的執行緒（cgroup 把執行緒也算進去）。cairo、pango 這類 C 程式庫執行時是否釋放 GIL，依函式庫與呼叫方式而定，所以要量測：

1. 用壓測工具同時送 N 個產生 PDF 的請求，記錄每秒完成數、p95 與 `docker stats`（方法見 [效能量測與壓測](#/skill/load-testing)）。
2. 換成 `-w 2 --threads 25`、`-w 4 --threads 12` 再跑。每個 worker 是獨立的行程，有自己的 GIL，也有自己一份記憶體，記憶體上限要跟著重算。
3. CPU 超過 100%、每秒完成數跟著上升，就是多行程有效。

GIL 的原理見 [電腦怎麼跑你的程式：行程、執行緒、記憶體](#/skill/how-programs-run)。

### 對應到 Kubernetes

| Docker | Kubernetes | 說明 |
|---|---|---|
| `--memory 1g` | `resources.limits.memory: 1Gi` | 同樣是 cgroup 上限，超過被 OOMKilled |
| `--cpus 2` | `resources.limits.cpu: "2"` | 同樣是節流 |
| 沒有對應 | `resources.requests` | 排程時保留的量，也是 HPA 算使用率的分母 |

寫法與 QoS 見 [Kubernetes 實作：設定、探針與資源](#/skill/k8s-config-probes)，數字怎麼估見 [硬體資源與容量規劃](#/skill/capacity-planning)。

## 重啟策略

| `--restart` | 什麼時候重啟 | 手動 `docker stop` 之後 |
|---|---|---|
| `no`（預設） | 不重啟 | 不重啟 |
| `on-failure[:N]` | 結束碼不是 0 才重啟；`:N` 限制最多重試 N 次 | 不重啟 |
| `always` | 不論結束碼 | 不重啟，但 Docker daemon 重啟（含主機開機）時會再把它啟動 |
| `unless-stopped` | 不論結束碼 | 不重啟，daemon 重啟後也維持停止 |

- 每次重啟前的等待從 100 毫秒開始加倍，容器重啟後正常跑超過 10 秒就回到 100 毫秒。`docker ps` 顯示 `Restarting (137) 3 seconds ago`，次數在 `docker inspect --format '{{.RestartCount}}'`。
- `docker update --restart unless-stopped payment-socket` 不用重建；compose 寫 `restart: unless-stopped`。
- 常駐服務用 `unless-stopped`，維護時手動停掉的不會在主機重開後被拉起來；一次性的工作用 `no` 或 `on-failure:3`。
- 每 40 分鐘 OOM 一次的容器，在 `docker ps` 上永遠是 `Up 12 minutes`。`RestartCount` 與 `oom` 事件要進監控。

Kubernetes 上，Docker 的 `--restart` 沒有作用，重啟由節點上的 kubelet 依 Pod 的 `restartPolicy` 決定：`Always`（預設，Deployment 只能用這個）、`OnFailure`、`Never`（Job 用後兩個）。等待時間從 10 秒開始加倍、上限 5 分鐘，容器正常跑 10 分鐘後重新計算；正在等待的狀態就是 `CrashLoopBackOff`，查法見 [Kubernetes 排錯](#/skill/k8s-troubleshooting)。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `Restarting (137) 2 seconds ago`，`OOMKilled=true` | 超過 `--memory`，重啟策略一直把它拉起來 | 看 `docker stats` 的趨勢：穩定偏高就調上限，一路上升就是洩漏 |
| gunicorn 的 log 出現 `Worker (pid:…) was sent SIGKILL! Perhaps out of memory?`，`docker ps` 看起來一切正常 | OOM killer 殺的是 worker，不是 PID 1，容器沒有結束 | `docker events` 看 `oom`；`docker stats` 看記憶體的趨勢 |
| 程式處理了 SIGTERM，`docker stop` 之後還是 `Exited (137)`、請求被切斷 | 寬限期比最長的請求短，Docker 先送了 SIGKILL | `-t` 或 `stop_grace_period` 設得比程式的等待上限長 |

## 動手

1. 執行關機的模擬，把 C 的 `drain` 改成 10：程式先放棄，結束碼變成 1，T3 一樣被切斷。再把 T3 的秒數改成 25，找出 `drain` 與 `grace` 至少要設多少。
2. 做本課的程式題：[補齊 compose 的維運設定](#/exercise/container-operations-2)。
3. 在有 Docker 的機器上寫一個每秒印一行、不會結束的 Python 腳本，用 `-v` 掛進 `python:3.12-slim` 執行。分三次 `time docker stop`：直接跑、加 `--init`、在腳本裡註冊 SIGTERM 處理函式。每次看 `docker inspect --format '{{.State.ExitCode}}'`，另一個終端機開著 `docker events` 對照訊號。
4. 依 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建好 kind 叢集，把 `clinic-api` 的 `limits.memory` 調到 `32Mi` 套用，用 `kubectl describe pod` 看 `Last State` 的 `OOMKilled` 與 Exit Code 137。
