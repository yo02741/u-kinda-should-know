## 同一週的兩件事：日誌塞滿磁碟、更新時切斷兩筆交易

院內的批價繳費系統跑在兩台 VM 上，每台用 Docker Engine 跑三個容器：

- `nginx`：對外的入口，把 `/api/` 轉給 `billing-api`。
- `billing-api`：Flask 後端，產生收據 PDF 並列印，主行程是 gunicorn。
- `payment-socket`：繳費機與刷卡機用長連線連進來，主行程是 `python payment_server.py`。

**週二早上 7:40**，批價櫃檯回報收據印不出來。`billing-api` 的 log 最後一行是 `OSError: [Errno 28] No space left on device: '/tmp/receipt-20261110-0412.pdf'`。

```bash
$ sudo du -sh /var/lib/docker/* 2>/dev/null | sort -h | tail -3
3.1G    /var/lib/docker/image
6.8G    /var/lib/docker/overlay2
41G     /var/lib/docker/containers

$ sudo ls -lh /var/lib/docker/containers/7f3e2a91c0d7…/
-rw-r----- 1 root root  41G Nov 10 07:41 7f3e2a91c0d7…-json.log
```

根分割區 100%，41 GB 是 `billing-api` 上線以來寫到 stdout 的每一行。Docker 預設的 json-file 日誌不輪替；上週有人把 log 等級調成 DEBUG 忘了改回來，之後每天多寫 7 GB。

**同一週**，每次更新 `payment-socket` 都停在 `Stopping` 約 10 秒。週四更新後，有兩筆刷卡交易逾時，要人工和銀行對帳。`docker events` 留下了經過：

```text
2026-11-12T12:30:04.112+08:00 container kill 5b9d… (name=payment-socket, signal=15)
2026-11-12T12:30:14.126+08:00 container kill 5b9d… (name=payment-socket, signal=9)
2026-11-12T12:30:14.309+08:00 container die 5b9d… (exitCode=137, name=payment-socket)
```

SIGTERM（15）送出 10 秒後，Docker 改送 SIGKILL（9），結束碼 137。`payment_server.py` 是 PID 1 而且沒有處理 SIGTERM，訊號被忽略（原理見 [Docker：image、container、layer](#/skill/docker-basics)），第 10 秒時手上的交易一起被切斷。

## 查一個出事的容器：四個指令與結束碼

| 指令 | 回答的問題 |
|---|---|
| `docker ps -a` | 有哪些容器、狀態、結束碼；不加 `-a` 看不到已經結束的 |
| `docker logs` | 主行程寫到 stdout、stderr 的內容 |
| `docker inspect` | 完整的設定與狀態：結束碼、`OOMKilled`、重啟次數 |
| `docker events` | 誰送了什麼訊號、何時 OOM、何時重啟 |

```bash
# 結束或重啟中的容器
docker ps -a --filter status=exited --filter status=restarting

# 最近 30 分鐘的錯誤。docker logs 把容器的 stderr 印到自己的 stderr，要 2>&1 才 grep 得到
docker logs --since 30m billing-api 2>&1 | grep -i error

# 一行看狀態、結束碼、OOM、重啟次數
docker inspect --format '{{.Name}} {{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' payment-socket

# 日誌設定，以及日誌檔在主機上的位置
docker inspect --format '{{json .HostConfig.LogConfig}} {{.LogPath}}' billing-api

# 程式實際拿到的環境變數（會印出秘密，注意畫面與紀錄）
docker exec billing-api env

# 這個容器的訊號、OOM 與結束事件；指令會繼續等新事件，看完按 Ctrl-C
docker events --since 1h --filter container=payment-socket --filter event=kill --filter event=oom --filter event=die

# 印一次就結束，不持續更新
docker stats --no-stream
```

| 結束碼 | 意思 | 常見原因 |
|---|---|---|
| 0 | 正常結束 | 程式做完事；處理完 SIGTERM 後自己結束 |
| 1 | 程式回報錯誤 | Python 有未捕捉的例外 |
| 137 | 被 SIGKILL 結束（128 + 9） | 超過記憶體上限；`docker stop` 等滿寬限期 |
| 143 | 被 SIGTERM 結束（128 + 15） | 用預設動作直接結束，沒有走自己的關機流程 |

137 搭配 `OOMKilled` 看：`true` 是記憶體；`false` 多半是停止時等滿寬限期，`payment-socket` 就是這種，修法是程式自己處理 SIGTERM（見 [容器的資源上限與優雅關機：OOM、重啟策略與 SIGTERM](#/skill/container-limits-signals)）。

## 替主機設好日誌輪替，以及兩個最常見的錯誤訊息

容器裡的程式把 log 寫到 stdout 與 stderr。Docker 預設的 `json-file` 驅動把每一行包成一筆 JSON 寫到主機的檔案，不輪替。整台主機的預設值寫在 `/etc/docker/daemon.json`，值一律寫成字串：

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
```

`max-size` 是單一檔案的大小上限，`max-file` 是最多保留幾個檔。設定**只對之後建立的容器生效**，既有的容器要重建：

```bash
sudo systemctl restart docker    # 套用 daemon.json；會停掉主機上所有容器，排在維護時段做
docker inspect --format '{{json .HostConfig.LogConfig}}' billing-api    # 重建容器後確認
# 磁碟已經滿了：清空檔案內容，不要刪檔
sudo truncate -s 0 "$(docker inspect --format '{{.LogPath}}' billing-api)"
```

| 訊息 | 原因 | 處理 |
|---|---|---|
| `OSError: [Errno 28] No space left on device`，`df` 顯示 100% | json-file 日誌沒有輪替 | truncate 急救；補上輪替並重建容器 |
| `exec: "bash": executable file not found in $PATH` | slim 映像沒有 bash | 改用 `sh`，或映像裡一定有的程式（`python -c …`） |

:::stop 讀到這裡可以先停：會用 ps、logs、inspect、events 查一個停掉的容器，看得懂結束碼，替主機設好日誌輪替。後面是其他查問題的手法、完整的結束碼、日誌驅動與用量估算，容器裡沒有 shell 或要估日誌多久塞滿磁碟時再回來讀。

## 查問題的其他手法：指令的用途、容器裡沒有 shell、完整的結束碼

開頭三個容器的完整設定（映像都放在院內的 Harbor）：

| 容器 | 做什麼 | 主行程 |
|---|---|---|
| `nginx` | 對外的入口，把 `/api/` 轉給 `billing-api` | nginx |
| `billing-api` | Flask 後端：產生收據 PDF（cairo、pango），送到批價櫃檯的印表機（cups） | `gunicorn -w 1 --threads 50 --keep-alive 75 …` |
| `payment-socket` | 自助繳費機與櫃檯刷卡機用長連線連進來，每筆交易在同一條連線上一問一答 | `python payment_server.py` |

`billing-api` 與 `payment-socket` 出自同一份 Dockerfile 的兩個 target，都以 root 執行。

| 指令 | 實際用途 |
|---|---|
| `docker ps -a` | `Exited (137) 2 hours ago`、`Restarting (1) 4 seconds ago` 一眼看出誰有事 |
| `docker logs` | `--since 30m` 看一段時間、`--tail 200` 看最後幾行、`-f` 持續跟著看、`-t` 加上時間 |
| `docker exec` | 在執行中的容器裡跑指令：看程式實際拿到的環境變數與設定檔、從容器的位置測連線 |
| `docker inspect` | JSON 格式；另有記憶體上限、日誌設定、掛載、執行的使用者 |
| `docker stats` | 當下的 CPU、記憶體、I/O、行程數：記憶體是不是一天比一天高、CPU 是不是卡在某個值 |
| `docker events` | 容器刪掉之後也查得到；只保留最近的一批事件，要長期留存得另外收集 |
| `docker top` | 容器裡有哪些行程：確認 PID 1 是程式本身而不是 shell；gunicorn 的 worker 還在不在 |
| `docker cp` | 在容器與主機之間複製檔案：把產生失敗的 PDF 拿出來；已經停止的容器也能複製 |

### 容器裡沒有 shell

`docker exec -it billing-api bash` 在 slim 映像上常得到：

```text
OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH: unknown
```

- 改用 `sh`（slim 映像通常有；distroless 連 sh 都沒有），或用映像裡一定有的程式：`docker exec billing-api python -c "import os; print(os.listdir('/tmp'))"`。
- 帶一個工具容器加入它的 namespace：`docker run --rm -it --network container:billing-api --pid container:billing-api <工具映像>`。`ss`、`curl`、`tcpdump` 在工具映像裡，正式映像不用裝；工具映像也放進 Harbor。
- 從主機進入它的網路 namespace，用主機上的工具：`sudo nsenter -t "$(docker inspect -f '{{.State.Pid}}' billing-api)" -n ss -tnp`。
- 容器已經停了就不能 `exec`，用 `docker cp` 把檔案拿出來。

Kubernetes 上對應的做法是 `kubectl debug` 加一個臨時容器，見 [Kubernetes 排錯](#/skill/k8s-troubleshooting)。

| 結束碼 | 意思 | 常見原因 |
|---|---|---|
| 1 | 程式回報錯誤 | traceback 在 `docker logs` |
| 125 | `docker run` 本身失敗，容器沒有啟動 | 參數錯誤、名稱衝突 |
| 126 | 指令存在但不能執行 | 沒有執行權限 |
| 127 | 找不到指令 | `CMD` 打錯、不在 PATH 裡 |
| 137 | 被 SIGKILL 結束（128 + 9） | 必讀的兩種原因之外，還有 `docker kill` |
| 139 | 被 SIGSEGV 結束（128 + 11） | 原生函式庫（C 寫的繪圖、PDF 程式庫）當掉 |

Kubernetes 的 `kubectl describe pod` 在 `Last State` 顯示同一組數字，查法見 [Kubernetes 排錯](#/skill/k8s-troubleshooting)。

## 日誌的細節：json-file 的格式、其他驅動與用量估算

Docker 用日誌驅動（logging driver）決定 log 收到哪裡。`json-file` 寫出來的檔案：

```text
/var/lib/docker/containers/<容器 ID>/<容器 ID>-json.log

{"log":"10.0.3.7 - - [10/Nov/2026:07:40:12 +0800] \"GET /api/receipts/88213 HTTP/1.0\" 200 5123 \"-\" \"kiosk/2.4\"\n","stream":"stdout","time":"2026-11-10T07:40:12.481305779Z"}
```

`docker logs` 讀的就是這個檔案。每一行多了 `stream`、`time` 與跳脫字元，寫到磁碟的量比程式印出的多。Docker 官方文件也提醒 json-file 預設不輪替，並建議改用 `local` 驅動。

| 選項 | 意思 | 預設 |
|---|---|---|
| `max-size` | 單一檔案到這個大小就換新檔（`10m`、`50m`） | 不限制 |
| `max-file` | 最多保留幾個檔，超過就刪最舊的；設了 `max-size` 才有作用 | 1 |
| `compress` | 輪替出去的舊檔要不要壓縮 | 不壓縮 |

單一容器在 `docker run` 時指定：

```bash
docker run -d --name billing-api \
  --log-opt max-size=50m --log-opt max-file=5 \
  harbor.example.org/billing/api:4.12.0
```

重啟 Docker 會停掉主機上所有容器（設了 `live-restore` 的除外），排在維護時段做。compose 重建容器用 `docker compose up -d --force-recreate`，寫法見 [docker-compose 開發環境](#/skill/compose) 的正式環境設定。

### 磁碟已經滿了

- `docker system df` 不含日誌檔，日誌要直接看 `/var/lib/docker/containers/`。
- `rm` 掉的日誌檔 dockerd 還開著，空間要等容器重建才釋放，所以用 truncate。需要的段落先用 `docker logs --since …` 存到別處。
- 之後補上輪替、重建容器，把 log 送到集中儲存（見 [可觀測性：log、metrics、trace](#/skill/observability)），監控 `/var/lib/docker` 所在分割區；它放在獨立分割區時，塞滿不會拖垮作業系統。

### 其他驅動

| 驅動 | 定位 |
|---|---|
| `local` | Docker 自己的格式，預設就輪替與壓縮（每個容器保留約 100 MB），`docker logs` 照樣能用 |
| `journald`、`syslog` | 交給主機的 journald 或 syslog，由主機既有的方式收走 |
| `fluentd`、`gelf` 等 | 直接送到集中的日誌系統；Docker 20.10 起本機另留一份快取，`docker logs` 還能用 |

### 算一下：多久會塞滿

下面用開頭的三個容器估算：每秒寫幾行、每行多大，json-file 每行再包上 JSON。數字是示意，換成自己的量測值再跑：

```python run
import json

def json_file_line(text):
    """json-file 寫到磁碟的一行：原文包成 JSON，再加上 stream 與 time"""
    rec = {"log": text + "\n", "stream": "stdout", "time": "2026-11-10T07:40:12.481305779Z"}
    return len(json.dumps(rec, separators=(",", ":"))) + 1     # 加上換行

access = '10.0.3.7 - - [10/Nov/2026:07:40:12 +0800] "GET /api/receipts/88213 HTTP/1.0" 200 5123 "-" "kiosk/2.4"'
print(f"一行 access log：原文 {len(access) + 1} 位元組，寫進 json-file 是 {json_file_line(access)} 位元組\n")

GB, MB = 1024 ** 3, 1024 ** 2
api_line = "x" * 220          # 示意：一行 220 字元的應用程式 log
pay_line = "x" * 120

normal = {                    # 容器：(每秒幾行, 一行的內容)
    "nginx": (6, access),
    "billing-api": (8, api_line),
    "payment-socket": (1, pay_line),
}
debug = dict(normal, **{"billing-api": (300, api_line)})   # billing-api 改成 DEBUG

def per_day(lines_per_sec, line):
    return lines_per_sec * json_file_line(line) * 86400

def no_rotation(title, rates, free_gb=40):
    total = 0
    print(title)
    for name, (lps, line) in rates.items():
        total += per_day(lps, line)
        print(f"  {name:<15} 每秒 {lps:>3} 行，每天 {per_day(lps, line) / GB:5.2f} GB")
    print(f"  合計每天 {total / GB:.2f} GB；剩 {free_gb} GB 時約 {free_gb * GB / total:.0f} 天塞滿\n")

no_rotation("不輪替，平常（INFO）", normal)
no_rotation("不輪替，billing-api 開著 DEBUG", debug)

def with_rotation(rates, max_size_mb=50, max_file=5):
    cap = max_size_mb * max_file
    print(f"max-size={max_size_mb}m、max-file={max_file}：每個容器最多 {cap} MB，"
          f"{len(rates)} 個容器合計 {cap * len(rates)} MB，和 log 等級無關")
    for name, (lps, line) in rates.items():
        hours = cap * MB / (lps * json_file_line(line)) / 3600
        print(f"  {name:<15} docker logs 最多看得到約 {hours:6.1f} 小時前")

with_rotation(debug)
```

輪替把磁碟用量封頂在 750 MB，代價是保留的時間：DEBUG 開著時，`billing-api` 只留得住不到一小時。主機上的日誌檔只是緩衝，要回頭查上週的事，log 得收到集中儲存。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `OSError: [Errno 28] No space left on device`，`df` 顯示 100% | json-file 日誌沒有輪替；或映像、建置快取堆積 | `du` 看 `/var/lib/docker/containers/`；用 truncate 急救；補 `max-size`、`max-file` 並重建容器 |
| 改了 daemon.json，日誌照樣在長 | 已經存在的容器保留建立時的日誌設定 | 重建容器，用 `docker inspect` 確認 `LogConfig` |
| dockerd 起不來，log 有 `cannot unmarshal number into Go value of type string` 之類 | daemon.json 的 `log-opts` 值寫成了數字 | 改成字串：`"max-file": "5"` |
| 更新 `billing-api` 後 nginx 一直回 502，重啟 nginx 就好 | nginx 啟動時解析一次 `billing-api` 的位址，重建的容器換了 IP | 更新後 reload nginx（`docker exec nginx nginx -s reload`）；要讓 nginx 定期重新解析，做法依 nginx 版本與 upstream 的寫法而定 |

## 動手

1. 在 Playground 執行日誌的估算，把 `max_size_mb` 改成 10、`max_file` 改成 3，看 DEBUG 時 `billing-api` 只留得住幾分鐘；再把 `free_gb` 改成主機上實際剩下的空間。
2. 做本課的程式題：[從 docker inspect 找出有問題的容器](#/exercise/container-operations-1)。
3. 用 `--log-opt max-size=1m --log-opt max-file=3` 啟動一個大量印 log 的容器，`sudo ls -lh` 它的日誌目錄，看 `-json.log`、`.1`、`.2` 怎麼輪替。

後續的課：記憶體與 CPU 上限、重啟策略、SIGTERM 與寬限期在 [容器的資源上限與優雅關機：OOM、重啟策略與 SIGTERM](#/skill/container-limits-signals)；Kubernetes 節點上的 `crictl` 與日誌、以非 root 執行、Docker Desktop 的授權在 [容器執行環境：containerd、crictl、非 root 與 Docker Desktop 授權](#/skill/container-runtimes)。
