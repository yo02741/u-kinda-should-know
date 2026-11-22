// 題庫：P11 新課（p1 批）：container-operations、container-limits-signals、container-runtimes
export default [
  {
    skill: 'container-operations',
    questions: [
      {
        q: '主機磁碟被 `billing-api` 的 json-file 日誌塞滿。值班同事在 `/etc/docker/daemon.json` 加上 `"log-opts": {"max-size": "50m", "max-file": "5"}`、重啟 Docker，三天後磁碟又在長，那個日誌檔已經超過 5 GB。最可能的原因是什麼？',
        options: [
          'json-file 不支援 max-size，要把 log-driver 改成 local 才會輪替',
          'max-file 要搭配 compress 一起設定，否則舊檔不會被刪掉',
          'daemon.json 只套用到之後建立的容器，billing-api 沒有重建，還是原本的設定',
          '重啟 Docker 之後日誌檔被重新開啟，要先 truncate 清空舊檔，輪替才會開始',
        ],
        answer: 2,
        explain: 'daemon.json 的 log-opts 是新容器的預設值；已經存在的容器保留建立時的日誌設定，要重建（例如 `docker compose up -d --force-recreate`）才會套用，可以用 `docker inspect --format \'{{json .HostConfig.LogConfig}}\'` 確認。json-file 本身支援 max-size 與 max-file；compress 只決定舊檔要不要壓縮，和刪不刪無關；truncate 是磁碟已滿時的急救，不會啟動輪替。',
      },
      {
        q: '`payment-socket` 更新後停在 `Exited (137)`。依下面的輸出，它是怎麼結束的？',
        code: '$ docker inspect --format \'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}\' payment-socket\nexit=137 oom=false restarts=0\n\n$ docker events --since 1h --filter container=payment-socket --filter event=kill\n… container kill 5b9d… (name=payment-socket, signal=15)\n… container kill 5b9d… (name=payment-socket, signal=9)',
        lang: 'bash',
        options: [
          '超過記憶體上限，被核心的 OOM killer 送 SIGKILL 結束',
          '停止時等滿寬限期：先收到 SIGTERM，之後被送 SIGKILL',
          '程式有未捕捉的例外，Python 印出 traceback 後自己結束',
          '收到 SIGTERM 後用預設動作直接結束，沒有走關機流程',
        ],
        answer: 1,
        explain: '137 是 128 + 9，代表被 SIGKILL 結束。`OOMKilled` 是 `false`，所以不是記憶體；`docker events` 顯示先送 signal 15、再送 signal 9，是停止時等滿寬限期。未捕捉的例外結束碼是 1；收到 SIGTERM 用預設動作直接結束是 143（128 + 15）。',
      },
      {
        q: '主機根分割區 100%，`billing-api` 的 `-json.log` 有 41 GB，容器還在服務中。要先把空間拿回來，哪個做法最合適？',
        options: [
          '用 `rm` 刪掉那個 `-json.log`，空間馬上就會釋放出來',
          '把 log 等級從 DEBUG 改回 INFO，已經寫入的日誌檔會跟著變小',
          '在 daemon.json 加上 `max-size` 再重啟 Docker，舊的日誌檔會被截斷',
          '需要的段落先另存，再用 `truncate -s 0` 清空那個日誌檔',
        ],
        answer: 3,
        explain: '`rm` 掉的日誌檔 dockerd 還開著，空間要等容器重建才釋放，所以用 truncate 清空內容，不刪檔；需要的段落先用 `docker logs --since …` 存到別處。改 log 等級只影響之後寫入的量。daemon.json 的設定只對之後建立的容器生效，既有容器的日誌檔不會因此變小；之後還是要補上輪替並重建容器。',
      },
    ],
  },
  {
    skill: 'container-limits-signals',
    questions: [
      {
        q: '付款的 socket 服務（`python payment_server.py` 是 PID 1，程式沒有處理 SIGTERM）每次 `docker stop` 都等 10 秒、交易被切斷。同事加上 `--init` 之後，`docker stop` 立刻完成、結束碼是 143，但櫃檯還是回報交易中斷。接下來該怎麼做？',
        options: [
          '把 `docker stop -t` 調成 60 秒，讓程式有足夠的時間把交易做完',
          '在 Dockerfile 加 `STOPSIGNAL SIGKILL`，讓容器直接結束，終端機就會馬上重連',
          '把重啟策略改成 `--restart always`，容器一結束就重新啟動，縮短中斷時間',
          '程式自己處理 SIGTERM：停收新連線、做完手上的交易再結束，`-t` 比等待上限長',
        ],
        answer: 3,
        explain: '加了 --init 後，tini 是 PID 1，把 SIGTERM 轉給 Python；Python 沒有處理函式，用預設動作當場結束（143），所以停得快，交易一樣被切斷。程式不處理 SIGTERM 時，調大 -t 沒有用：它在收到訊號的瞬間就結束了。STOPSIGNAL SIGKILL 等於每次都硬殺；重啟策略只影響結束之後，不會讓進行中的交易做完。',
      },
      {
        q: '`billing-api` 用 `gunicorn -w 1 --threads 50` 跑，容器設了 `--cpus 4`。產生收據 PDF 的尖峰時段請求大量排隊，下面是當時的輸出。哪個判斷與下一步最合理？',
        code: '$ docker stats --no-stream billing-api\nCONTAINER ID   NAME          CPU %     MEM USAGE / LIMIT   MEM %     PIDS\n7f3e2a91c0d7   billing-api   100.82%   790MiB / 2GiB       38.57%    53\n\n$ docker inspect --format \'{{.State.OOMKilled}} {{.RestartCount}}\' billing-api\nfalse 0',
        lang: 'bash',
        options: [
          'CPU 只用到 1 顆，像是單一行程受 GIL 限制；壓測多個 worker 的設定',
          'CPU 被 --cpus 節流了，把上限調到 8 顆，排隊就會消失',
          '執行緒不夠用，把 --threads 調到 100，讓更多請求同時進行',
          '記憶體快到上限，Python 正在頻繁回收記憶體而變慢；把記憶體上限調到 4 GiB',
        ],
        answer: 0,
        explain: '上限是 400%，實際卻停在 100% 左右，請求還在排隊，這是一個行程裡的執行緒在搶同一把 GIL 的樣子：產生 PDF 的運算大部分在 Python 層時，同一時間只有一個執行緒能跑。調高 --cpus 或 --threads 都還是同一個行程；記憶體只用了 38%，也沒有 OOM。多個 worker 是多個行程、各有自己的 GIL，但也各有一份記憶體，要量測每秒完成數與記憶體再決定。',
      },
      {
        q: '`billing-api`（`gunicorn -w 1 --threads 50`）設了 `--memory 1g`。尖峰時 nginx 偶爾整批回 502，但 `docker ps` 顯示容器一直是 `Up`，`RestartCount` 是 0。gunicorn 的 log 有一行 `Worker (pid:23) was sent SIGKILL! Perhaps out of memory?`。發生了什麼事？',
        options: [
          '容器超過記憶體上限後整個被砍，重啟策略立刻把它拉起來，所以一直是 Up',
          'OOM killer 殺的是 worker，不是 PID 1：容器沒有結束，master 重開一個 worker',
          'CPU 被 `--cpus` 節流，worker 回應太慢，被 Docker 判定沒有回應而送 SIGKILL',
          '`docker stop` 的寬限期太短，worker 來不及做完手上的請求就被 SIGKILL',
        ],
        answer: 1,
        explain: '超過 `--memory` 時，核心的 OOM killer 在容器的 cgroup 裡挑一個行程送 SIGKILL。被挑中的是 gunicorn 的 worker 時，PID 1（master）還在，容器不會結束，master 重開一個 worker；`-w 1` 時唯一的 worker 手上 50 個執行緒的請求全部中斷，nginx 回 502。整個容器被砍再拉起來的話，`RestartCount` 會增加。CPU 超過上限是節流，變慢但不會被砍；這裡也沒有人執行 `docker stop`。',
      },
    ],
  },
  {
    skill: 'container-runtimes',
    questions: [
      {
        q: '叢集的節點用 containerd。在一台節點上要看某個容器最後 100 行 log，`docker logs` 回 `docker: command not found`。該怎麼做？',
        options: [
          '節點上的容器只能從叢集外用 `kubectl` 查，節點本機沒有工具可用',
          '用 `crictl ps -a` 找到容器 ID，再執行 `crictl logs --tail 100 <容器 ID>`',
          '映像是用 `docker build` 建的，containerd 不能直接跑，要先在節點上用 Podman 重建一次',
          '用 `crictl` 另外建立一個同映像的容器重現問題，再看新容器的 log',
        ],
        answer: 1,
        explain: 'Kubernetes 1.24 起移除了 dockershim，節點上的容器執行環境是 containerd 或 CRI-O，多半沒有 docker 指令。`crictl` 直接和 CRI 溝通，`ps`、`logs`、`inspect` 都有對應的指令，容器用 ID 指定。Docker 建出來的是 OCI 映像，containerd 能直接跑，不用重建。用 `crictl` 直接建立的容器會被 kubelet 清掉，它只拿來排錯。',
      },
      {
        q: '`billing-api` 要部署到要求以非 root 執行的 namespace。下面的 Dockerfile 片段建置成功，Kubernetes 的 `runAsNonRoot` 卻無法確認它不是 root。要改哪裡？',
        code: 'RUN groupadd --system --gid 10001 app \\\n && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app\nUSER app',
        lang: 'bash',
        options: [
          '把 `USER app` 改成 `USER 10001:10001`，用數字 UID 指定使用者',
          '拿掉 `--no-create-home`，讓 app 有自己的家目錄可以寫入',
          '把 `USER app` 移到 `RUN` 前面，建立帳號的步驟也不用 root',
          '把 UID 改成 1000 以下的數字，系統帳號才會被 Kubernetes 當成非 root 的使用者',
        ],
        answer: 0,
        explain: 'Kubernetes 的 `runAsNonRoot` 要有數字 UID 才能確認不是 root，所以 `USER` 寫成 `10001:10001`。有沒有家目錄和是不是 root 無關：沒有家目錄時，把 `HOME`、`XDG_CACHE_HOME` 指到 `/tmp`。`groupadd`、`useradd` 要以 root 執行，`USER` 得放在它們後面。root 是 UID 0，10001 已經不是 root。',
      },
      {
        q: '一家 1,200 名員工的醫院，資訊室想在開發用的 Windows 筆電裝 Docker Desktop 跑本機的 kind 叢集。安裝前要先確認什麼？',
        options: [
          '只拿來開發、不對外提供服務，屬於個人使用，不需要確認授權',
          'Docker Engine 是開源的，所以 Docker Desktop 在任何組織都能免費用',
          '只有正式環境的伺服器才需要授權，開發機一律不在條款的範圍內',
          '員工超過 250 人，商業使用需要付費訂閱；先確認院方已經有授權',
        ],
        answer: 3,
        explain: 'Docker Desktop 可以免費使用的情況是：員工少於 250 人而且年營收少於 1,000 萬美元的組織、個人使用、教育用途、非商業的開源專案；超過這個範圍的商業使用需要付費訂閱，政府機關不購買訂閱就不能用。開源的是 Linux 伺服器上用套件安裝的 Docker Engine，Docker Desktop 是另一個產品。沒有授權時，可以改用 Rancher Desktop、Podman Desktop，或 WSL 2 裡的 Docker Engine。',
      },
    ],
  },
]
