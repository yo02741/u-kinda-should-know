// 領域內文（d6-deploy，p1 批）：以技能 id 為 key，由 body/d6-deploy.js 合併。只放這些技能：container-operations、container-limits-signals、container-runtimes
export default {
  'container-operations': {
    map: {
      names: [
        { n: '結束碼 137 與 143', t: '137 是被 SIGKILL（`OOMKilled=true` 是記憶體，`false` 多半是停止時等滿寬限期），143 是收到 SIGTERM 用預設動作結束。' },
        { n: '日誌輪替（`max-size`、`max-file`）', t: 'json-file 驅動預設不輪替；寫在 daemon.json 只對之後建立的容器生效，既有的要重建。' },
        { n: '`docker inspect`', t: '完整的設定與狀態：結束碼（`State.ExitCode`）、`OOMKilled`、`RestartCount`、日誌設定（`HostConfig.LogConfig`）與日誌檔在主機上的位置（`LogPath`）。' },
        { n: '`docker events`', t: '誰送了什麼訊號、何時 OOM、何時重啟；容器刪掉之後也查得到，但只保留最近的一批事件。' },
        { n: '日誌驅動（`json-file`、`local`）', t: 'json-file 把每一行包成 JSON 寫到主機的檔案，預設不輪替；`local` 預設就輪替與壓縮，`docker logs` 照樣能用。' },
        { n: '結束碼 125、126、127', t: '125 是 `docker run` 本身失敗、容器沒有啟動；126 是指令存在但不能執行；127 是找不到指令（`CMD` 打錯、不在 PATH 裡）。' },
      ],
      ask: [
        '日誌輪替的設定（`max-size`、`max-file`），寫在 daemon.json 還是 compose 的 `logging`。',
        '要查的是哪個容器、哪一段時間，手上已經有的線索（結束碼、`OOMKilled`、重啟次數）。',
        'log 寫到 stdout 還是容器裡的檔案、現在的 log 等級、每秒大約寫幾行。',
        '主機上要留得住多久的 log，更久以前的收到哪裡。',
      ],
      prompt: '`billing-api` 今天早上 7:40 起收據印不出來，主機根分割區 100%。檢查步驟：`docker ps -a` 與 `docker inspect` 看狀態、結束碼、`OOMKilled` 與 `RestartCount`，`docker logs --since 30m` 找錯誤，用 `docker inspect` 的 `LogPath` 看日誌檔多大。修正：`/etc/docker/daemon.json` 設 json-file 的 `max-size: "50m"`、`max-file: "5"`（值是字串）並重建容器；磁碟已滿時用 `truncate` 清空日誌檔，不刪檔。',
      verify: [
        { c: '輪替有沒有套用', t: '`docker inspect --format \'{{json .HostConfig.LogConfig}}\' billing-api` 要看到 `max-size`；`Config` 是空的代表容器建立在改設定之前，要重建。' },
        { c: '日誌檔有多大', t: '`sudo ls -lh "$(docker inspect --format \'{{.LogPath}}\' billing-api)"`；`docker system df` 不含日誌檔，看不出這一塊。' },
        { c: '結束的原因', t: '`docker ps -a` 顯示 `Exited (137)` 時再看 `docker inspect --format \'{{.State.OOMKilled}}\'`：`true` 是記憶體，`false` 多半是停止時等滿寬限期。' },
        { c: 'grep 不到錯誤', t: '`docker logs` 把容器的 stderr 印到自己的 stderr，要寫成 `docker logs billing-api 2>&1 | grep -i error`。' },
      ],
    },
    points: [
      { b: '先查再動手', t: '`docker ps -a` 看結束碼、`docker logs --since 30m` 看程式說了什麼、`docker inspect` 看 `OOMKilled` 與 `RestartCount`、`docker events` 看誰送了什麼訊號。137 加上 `OOMKilled=true` 是記憶體，`false` 多半是停止時等滿寬限期；143 是程式收到 SIGTERM 用預設動作直接結束。' },
      { b: '日誌要輪替', t: '預設的 json-file 不輪替，log 會長到磁碟滿。用 `--log-opt max-size=50m --log-opt max-file=5`，或寫在 daemon.json（值一律是字串）；daemon.json 只對之後建立的容器生效，改完要重建。磁碟已滿時 `truncate` 清空，不要 `rm`。' },
      { b: '容器裡沒有 shell', t: 'slim 映像常沒有 bash：改用 `sh`，或映像裡一定有的程式（`python -c …`）；distroless 連 sh 都沒有，帶一個工具容器加入它的 namespace（`--network container:…`、`--pid container:…`），或從主機用 `nsenter`。已經停止的容器不能 `exec`，用 `docker cp` 把檔案拿出來。' },
      { b: '結束碼不只 137', t: '1 是程式回報錯誤，traceback 在 `docker logs`；125 是 `docker run` 本身失敗、容器沒有啟動；126 是指令不能執行；127 是找不到指令；139 是被 SIGSEGV 結束，常見於原生函式庫當掉。' },
      { b: '輪替封頂磁碟用量，代價是保留的時間', t: '`max-size` 乘上 `max-file` 是每個容器的上限，和 log 等級無關；DEBUG 開著時，`docker logs` 可能只留得住不到一小時。主機上的日誌檔只是緩衝，要回頭查上週的事，log 得收到集中儲存。`local` 驅動預設就輪替與壓縮。' },
    ],
    checklist: [
      '能替一台主機設好日誌輪替，並用 `docker inspect` 確認既有的容器已經重建套用',
      '能用 `docker ps -a`、`docker inspect`、`docker events` 判斷一個容器為什麼結束，分得出 `Exited (137)` 是記憶體超過上限還是停止逾時',
      '磁碟被日誌塞滿時，能找出是哪個容器的日誌檔、用 `truncate` 急救，並估算設了輪替之後 `docker logs` 留得住多久',
    ],
    challenge: {
      task: '執行本課「算一下：多久會塞滿」的程式（區塊下方有「在 Playground 開啟」）。把 `normal` 與 `debug` 的每秒行數換成一個自己維運的服務的量測值（沒有就假設 nginx 每秒 20 行、API 每秒 30 行、DEBUG 時 500 行），`free_gb` 換成主機實際剩下的空間。執行前先預測：不輪替時幾天塞滿；`max-size=50m`、`max-file=5` 時，DEBUG 下 `docker logs` 留得住幾小時。再選一組 `max-size` 與 `max-file`，讓 DEBUG 開著時至少留得住 4 小時。',
      deliver: '預測與程式輸出的對照，以及選定的 `max-size`、`max-file` 與理由',
      check: [
        '預測在執行前寫下，和輸出並排',
        '寫出每秒行數與每行大小的來源（量測方式或假設）',
        '選定的設定附上程式輸出：每個容器的上限是多少 MB、DEBUG 時留得住幾小時',
        '說明主機上留不住的 log 要靠什麼才查得到',
      ],
      twist: '同一台主機再加 10 個容器，全部用同一組設定。先預測：日誌占用的磁碟上限變成多少、每個容器留得住的時間會不會變，再決定要不要改設定。',
    },
    refs: [
      { label: 'Docker：JSON File logging driver', url: 'https://docs.docker.com/engine/logging/drivers/json-file/' },
    ],
  },
  'container-limits-signals': {
    map: {
      names: [
        { n: '記憶體上限與 OOM killer', t: '超過 `--memory` 時核心送 SIGKILL；被殺的是 PID 1 容器就結束，是 gunicorn 的 worker 則容器還在。' },
        { n: 'CPU 上限（`--cpus`）', t: '超過是節流，不會被殺；CPU 卡在 100% 而上限更高，通常是單一 Python 行程受 GIL 限制。' },
        { n: 'SIGTERM 與寬限期', t: '`docker stop` 先送 SIGTERM，等 `-t`（預設 10 秒）後送 SIGKILL；Kubernetes 對應 `terminationGracePeriodSeconds`。' },
        { n: '`--init`', t: '讓 tini 當 PID 1、轉送訊號；程式沒處理 SIGTERM 時一樣當場結束，手上的工作照樣被切斷。' },
        { n: '重啟策略', t: '`--restart unless-stopped`、`on-failure`；`RestartCount` 一直增加代表程式反覆崩潰。' },
      ],
      ask: [
        '記憶體與 CPU 上限，以及超過時預期的行為（worker 被砍或整個容器結束）。',
        '收到 SIGTERM 之後程式做什麼：停收新請求、手上的工作最多等幾秒、再結束；寬限期多長。',
        '重啟策略，以及重啟幾次要告警。',
      ],
      prompt: '收據服務 `billing-api` 用 compose 部署：`mem_limit: 1g`、`cpus: 2`；`restart: unless-stopped`；`init: true`；`stop_grace_period: 30s`。程式收到 SIGTERM 後停收新請求，手上的請求最多等 20 秒（比 30 秒短）再結束。`RestartCount` 與 `oom` 事件進監控。',
      verify: [
        { c: '停止要多久', t: '`time docker stop billing-api` 剛好等於寬限期、`docker inspect --format \'{{.State.ExitCode}}\'` 是 137，代表程式沒處理 SIGTERM；正常收尾的結束碼是 0。' },
        { c: '被殺的原因', t: '`docker inspect --format \'{{.State.OOMKilled}} {{.State.ExitCode}}\'` 得到 `true 137` 是記憶體；另開終端機跑 `docker events --filter container=billing-api` 看 `kill` 事件的 `signal`。' },
        { c: '資源用量', t: '`docker stats --no-stream` 的 CPU% 停在 100% 左右而上限是 200%，先懷疑單一行程，量測多開 worker 的效果，不是先調高上限。' },
        { c: '有沒有反覆重啟', t: '`docker inspect --format \'{{.RestartCount}}\'` 一直增加；`docker ps` 的 `Up 12 minutes` 看不出來，要對照 `docker events` 的 `oom` 與 `die`。' },
        { c: '在 Kubernetes 上', t: '`kubectl describe pod` 的 `Last State` 看 `Reason: OOMKilled` 與 `Exit Code: 137`；一直重啟的 Pod 狀態是 `CrashLoopBackOff`。' },
      ],
    },
    points: [
      { b: '關機：SIGTERM 與寬限期', t: 'PID 1 沒處理 SIGTERM 時，`docker stop` 等滿 10 秒送 SIGKILL。`--init` 讓它立刻停，但程式用預設動作當場結束，交易一樣被切斷。程式要停收新連線、做完手上的、再結束；寬限期由內而外：程式的等待上限 < `docker stop -t` 或 `terminationGracePeriodSeconds`。' },
      { b: '長連線由伺服器在交易之間關閉', t: 'SIGTERM 的處理函式只設旗標；`accept` 設逾時，主迴圈才看得到旗標。每條連線把手上的交易做完再關閉，終端機重連到新的容器並重送；重送前先用交易編號查詢結果，避免重複扣款。' },
      { b: '記憶體與 CPU 的上限', t: '`--memory` 超過時 OOM killer 送 SIGKILL：PID 1 被殺容器就結束；gunicorn 的 worker 被殺時容器還在，線索在 log 的 `Perhaps out of memory?`。`--cpus` 超過是節流。CPU 卡在 100% 而上限更高，是單一 Python 行程受 GIL 限制，量測多個 worker 的效果。' },
      { b: '`--memory-swap` 與記憶體的趨勢', t: '只設 `--memory`、主機又有 swap 時，容器還能再用同樣大小的 swap，變慢比被砍更難察覺；設成和 `--memory` 一樣就不用 swap。`docker stats` 的曲線一路往上不回落是洩漏，到某個高度就平是上限太小或並行太高。' },
      { b: '重啟策略', t: '常駐服務用 `unless-stopped`，一次性的工作用 `no` 或 `on-failure:3`。每次重啟前的等待從 100 毫秒開始加倍。反覆 OOM 的容器在 `docker ps` 上永遠是 `Up` 幾分鐘，`RestartCount` 與 `oom` 事件要進監控。Kubernetes 上由 kubelet 依 Pod 的 `restartPolicy` 重啟，正在等待的狀態是 `CrashLoopBackOff`。' },
    ],
    checklist: [
      '能替 PID 1 的 Python 服務補上 SIGTERM 處理，並把程式的等待上限、`docker stop -t`（或 `stop_grace_period`）、`terminationGracePeriodSeconds` 由內而外設好',
      '能從 `OOMKilled`、`docker events` 與 gunicorn 的 log 分辨被 OOM 殺掉的是 PID 1 還是 worker，並說明 CPU 卡在 100% 時調高 `--cpus` 為什麼沒有幫助',
      '能替常駐服務與一次性的工作各選一種重啟策略，並說出反覆重啟要看哪個數字',
    ],
    challenge: {
      task: '用標準函式庫寫一個最小的 HTTP 服務，`/slow` 要 8 秒才回，跑在 `python:3.12-slim` 容器裡。另一個終端機每秒送一次 `/slow`（例如 `while true; do curl -s -o /dev/null -w \'%{http_code} %{time_total}\\n\' localhost:8000/slow & sleep 1; done`），第 5 秒時執行 `docker stop`。做三個版本：程式不處理 SIGTERM、加 `--init`、程式自己處理（停收新連線、做完手上的再結束）。動手前先預測每個版本有幾個請求拿到 200、幾個連線失敗。',
      deliver: '三個版本各一份：`curl` 的輸出、`time docker stop` 的秒數、`docker inspect --format \'{{.State.ExitCode}}\'` 的結果',
      check: [
        '三個版本的預測與實際結果並列',
        '從結束碼分得出三個版本（137、143、0）',
        '第三個版本裡，`docker stop` 之前送出的請求都拿到 200，之後的連線被拒絕',
        '寫出程式的等待上限與 `docker stop -t` 各設多少，以及前者為什麼要比較短',
      ],
      twist: '同一個服務搬到 Kubernetes，前面有 Service。先預測：Pod 收到 SIGTERM 之後的幾秒內還會不會有新請求進來，程式或 manifest 要多做什麼。',
    },
    refs: [
      { label: 'Docker：Resource constraints', url: 'https://docs.docker.com/engine/containers/resource_constraints/' },
      { label: 'Docker：Start containers automatically', url: 'https://docs.docker.com/engine/containers/start-containers-automatically/' },
    ],
  },
  'container-runtimes': {
    map: {
      names: [
        { n: 'OCI', t: '映像格式、怎麼把映像跑成容器、registry 的 API 三份共通規格；Docker 建出來的映像因此能在 containerd、CRI-O、Podman 上跑。' },
        { n: 'containerd 與 CRI-O', t: 'Kubernetes 節點上的容器執行環境，實作 CRI。1.24 起移除 dockershim，節點上多半沒有 docker 指令。' },
        { n: '`crictl`', t: 'Kubernetes 節點上用 containerd 或 CRI-O，沒有 docker 指令，用 `crictl ps`、`crictl logs` 查容器。' },
        { n: 'Podman', t: '沒有常駐程式、可以用一般使用者執行（rootless），指令大致與 docker 相容。' },
        { n: '數字 UID 的 `USER`', t: 'Dockerfile 寫 `USER 10001:10001`；Kubernetes 的 `runAsNonRoot` 要數字 UID 才能確認不是 root。' },
        { n: 'Docker Desktop 的訂閱條款', t: '員工少於 250 人而且年營收少於 1,000 萬美元的組織、個人、教育、非商業的開源專案可以免費用；其他商業使用要付費訂閱，政府機關不購買訂閱就不能用。' },
      ],
      ask: [
        '以哪個數字 UID 執行，哪些目錄要可寫。',
        '映像要在哪些執行環境上跑（Docker Engine、containerd、CRI-O），節點上用什麼工具排錯。',
        '暫存檔、要保留的檔案、字型快取各寫到哪裡。',
        '開發機用哪個桌面工具跑容器，授權由誰確認。',
      ],
      prompt: '`billing-api` 的映像要能在套用 Pod Security `restricted` 的 namespace 執行：Dockerfile 在共用的階段建立 UID 10001 的使用者並寫 `USER 10001:10001`，程式碼目錄維持 root 擁有、只能讀；暫存檔用 `tempfile` 寫 `/tmp`，要保留的檔案放 volume，`HOME` 與 `XDG_CACHE_HOME` 指到 `/tmp`。測試環境用 `--read-only --tmpfs /tmp` 跑一次，確認沒有寫到別處。',
      verify: [
        { c: '是不是 root', t: '`docker inspect --format \'{{.Config.User}}\' billing-api` 印出空字串，或 `docker exec billing-api id` 印出 `uid=0(root)`，就是以 root 執行。' },
        { c: '有沒有寫到別處', t: '加 `--read-only --tmpfs /tmp` 啟動，程式寫到別處會立刻得到 `Read-only file system`；log 出現 `Fontconfig error: No writable cache directories` 代表快取目錄不可寫。' },
        { c: '在 Kubernetes 節點上', t: '用 `crictl ps -a`、`crictl logs <容器 ID>` 查容器；`crictl` 警告沒有設定 endpoint 時，在 `/etc/crictl.yaml` 設 `runtime-endpoint`。' },
        { c: 'log 在哪裡', t: '節點上的 `/var/log/pods/<namespace>_<pod>_<uid>/<容器>/`；`kubectl logs` 只讀得到最新的那個檔案，程式自己寫進容器裡的 log 檔不會被收集。' },
      ],
    },
    points: [
      { b: '同一個映像，不同的執行環境', t: 'OCI 映像在 Docker Engine、containerd、CRI-O、Podman 上都能跑。Kubernetes 1.24 起移除 dockershim，節點上用 `crictl` 查容器。Pod Security 的 restricted 會擋以 root 執行的 Pod，映像先改成數字 UID 的非 root 使用者，寫檔改到 `/tmp` 或 volume。' },
      { b: '節點上用 `crictl` 排錯', t: '`crictl ps -a`、`crictl pods`、`crictl logs`、`crictl inspect` 對應 docker 的指令，容器用 ID 指定；沒有建置與推送。日常操作還是 `kubectl`，用 `crictl` 直接建立的容器會被 kubelet 清掉。要連哪個執行環境寫在 `/etc/crictl.yaml` 的 `runtime-endpoint`。' },
      { b: 'Kubernetes 上的日誌', t: '容器的 stdout 與 stderr 由容器執行環境寫到節點的 `/var/log/pods/`，kubelet 依大小輪替；Pod 上沒有 Docker 的 `--log-opt`。`kubectl logs` 只讀得到最新的那個檔案，輪替出去的、Pod 刪除後的 log 要靠 DaemonSet 收到叢集外。' },
      { b: '以非 root 執行', t: '`USER` 寫數字 UID。暫存檔用 `tempfile` 寫 `/tmp`，要保留的檔案放 volume（既有的 volume 先 `chown` 一次）；字型快取在建置時先 `fc-cache -f`，執行時把 `HOME`、`XDG_CACHE_HOME` 指到 `/tmp`。測試環境用 `--read-only --tmpfs /tmp` 找出漏掉的寫入。' },
      { b: 'Docker Desktop 要先看授權', t: '員工少於 250 人而且年營收少於 1,000 萬美元的組織、個人使用、教育用途、非商業的開源專案可以免費用，其他商業使用需要付費訂閱；政府機關不購買訂閱就不能用。Linux 伺服器上用套件安裝的 Docker Engine 是開源的，授權沒有變。替代方案有 Rancher Desktop、Podman Desktop、WSL 2 裡的 Docker Engine。條款會改，以 Docker 官方說明為準。' },
    ],
    checklist: [
      '能說明院內開發機使用 Docker Desktop 前要確認的授權條件，以及有哪些替代方案',
      '能在 Kubernetes 節點上用 `crictl` 找到一個容器、看它的 log，並說出哪些 log 用 `kubectl logs` 看不到',
      '能把以 root 執行的映像改成數字 UID 的非 root 使用者，並處理暫存檔、volume 與快取目錄的寫入權限',
    ],
    challenge: {
      task: '照本課「動手」第 1 步建好 kind 叢集，在節點裡用 `crictl ps` 找到 `clinic-api` 的容器。動手前先預測三件事：`crictl logs` 與 `kubectl logs` 印出的內容是否相同；節點上 `/var/log/pods/` 底下這個容器有幾個 log 檔；刪掉 Pod 之後，原本的 log 檔還在不在。再逐一驗證。',
      deliver: '三個預測與實際結果的對照，附上用到的指令與輸出的關鍵幾行',
      check: [
        '預測在執行前寫下，和結果並排',
        '附上 `crictl ps` 找到的容器 ID 與 `/var/log/pods/` 底下的實際路徑',
        '說明 `kubectl logs` 讀的是哪個檔案，以及哪些 log 用它看不到',
        '寫出 Pod 刪除後要靠什麼才查得到它的 log',
      ],
      twist: '節點的容器執行環境從 containerd 換成 CRI-O。先預測：映像要不要重建、`crictl` 的指令要不要改、`/etc/crictl.yaml` 要改哪一行。',
    },
    refs: [
      { label: 'Docker Desktop license agreement', url: 'https://docs.docker.com/subscription/desktop-license/' },
      { label: 'Kubernetes：Logging Architecture', url: 'https://kubernetes.io/docs/concepts/cluster-administration/logging/' },
      { label: 'Kubernetes：Debugging Kubernetes nodes with crictl', url: 'https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/' },
    ],
  },
}
