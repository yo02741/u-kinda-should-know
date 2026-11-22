## 節點上沒有 docker 指令，以 root 執行的 Pod 被擋下

本課接在 [容器的日常維運：查問題、結束碼與日誌](#/skill/container-operations) 之後。同一套批價繳費系統準備從兩台 VM 搬上 Kubernetes，三件事和 VM 上不一樣：

| 現象 | 原因 |
|---|---|
| 在節點上照 VM 的習慣查容器，得到 `docker: command not found` | 節點上的容器執行環境是 containerd 或 CRI-O，多半沒有 docker 指令 |
| `billing-api` 與 `payment-socket` 的 Pod 在套用 Pod Security `restricted` 等級的 namespace 被擋下 | 兩個映像出自同一份 Dockerfile 的兩個 target，都以 root 執行 |
| 開發機要用 Docker Desktop 跑本機的 kind 叢集 | 大型組織與政府機關要先有付費訂閱 |

## 同一個映像，不同的執行環境：OCI、containerd、CRI-O、Podman

Docker 建出來的映像能在其他執行環境上跑，因為 OCI（Open Container Initiative）定了三份共通規格：映像格式（image spec）、怎麼把映像跑成容器（runtime spec）、registry 的 API（distribution spec）。runc 是 runtime spec 的參考實作，下面幾個工具最後多半呼叫它（或 crun）建立 namespace 與 cgroup。

| 名稱 | 定位 | 常見在哪裡 |
|---|---|---|
| Docker Engine（dockerd） | 完整的容器平台：建置、執行、網路、volume，加上 compose；底下用 containerd 與 runc | 開發機、單機伺服器（現在的兩台 VM） |
| containerd | 管理映像與容器生命週期的常駐程式，實作 Kubernetes 的 CRI | 多數 Kubernetes 發行版的節點；也是 Docker Engine 的底層 |
| CRI-O | 只為 Kubernetes 寫的 CRI 實作 | OpenShift 的節點，以及選用它的叢集 |
| Podman | 沒有常駐程式（daemonless），可以用一般使用者執行（rootless），指令大致與 docker 相容；能從容器產生 Kubernetes 的 YAML、交給 systemd 管理 | RHEL 系的伺服器、開發機 |

## 在節點上用 crictl 查容器

Kubernetes 1.24 起移除了 dockershim，節點上的容器執行環境是 containerd 或 CRI-O，多半沒有 docker 指令。查節點上的容器用 `crictl`，它直接和 CRI 溝通：

```bash
# 在節點上執行；容器用 ID 指定
crictl ps -a                        # 列出容器（含已結束的）
crictl pods                         # 列出 Pod
crictl logs --tail 100 <容器 ID>    # 看 log
crictl inspect <容器 ID>            # 詳細資訊
```

`crictl` 是在節點上排錯用的，日常操作還是 `kubectl`；用 `crictl` 直接建立的容器會被 kubelet 清掉。要連哪個執行環境寫在 `/etc/crictl.yaml` 的 `runtime-endpoint`（containerd 常見是 `unix:///run/containerd/containerd.sock`，CRI-O 是 `unix:///var/run/crio/crio.sock`）。

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| Kubernetes 節點上 `docker: command not found`；`crictl` 警告沒有設定 endpoint | 1.24 起節點用 containerd 或 CRI-O；`crictl` 不知道要連哪一個 | 改用 `crictl`，在 `/etc/crictl.yaml` 設定 `runtime-endpoint` |
| 用 `crictl` 直接建立的容器不見了 | kubelet 會清掉用 `crictl` 直接建立的容器 | 日常操作用 `kubectl`，`crictl` 只拿來排錯 |

:::stop 讀到這裡可以先停：知道 Docker、containerd、CRI-O、Podman 跑的是同一種 OCI 映像，會在 Kubernetes 節點上用 `crictl` 查容器。後面的指令對照、節點上的日誌、以非 root 執行、Docker Desktop 的授權，在映像要通過 Pod Security 或開發機要選桌面工具時再回來讀。

## docker 與 crictl 的指令對照

| 要做的事 | Docker | crictl |
|---|---|---|
| 列出容器（含已結束的） | `docker ps -a` | `crictl ps -a` |
| 列出 Pod | 沒有對應 | `crictl pods` |
| 看 log | `docker logs --tail 100 <容器>` | `crictl logs --tail 100 <容器 ID>` |
| 在容器裡執行指令 | `docker exec -it <容器> sh` | `crictl exec -it <容器 ID> sh` |
| 列出映像 | `docker images` | `crictl images` |
| 拉映像 | `docker pull` | `crictl pull` |
| 詳細資訊 | `docker inspect` | `crictl inspect <容器 ID>` |
| 資源用量 | `docker stats` | `crictl stats` |
| 清掉沒在用的映像 | `docker image prune -a` | `crictl rmi --prune` |
| 建置、推送映像 | `docker build`、`docker push` | 沒有；映像在 CI 建好推到 Harbor |

CI 用 `docker build` 建好推到 Harbor，VM 上的 Docker Engine 與節點上的 containerd 拉到的是同一個 digest。Harbor 的權限見 [私有映像倉庫：Harbor 的專案、機器人帳號與 CI 推送](#/skill/container-registry)，離線同步見 [外部映像與斷網環境：代理快取、叢集拉取與映像搬運](#/skill/registry-airgap)。

## Kubernetes 上的日誌

- 容器的 stdout 與 stderr 由節點上的容器執行環境寫成檔案（`/var/log/pods/<namespace>_<pod>_<uid>/<容器>/`），kubelet 依大小輪替。設定是 kubelet 的 `containerLogMaxSize` 與 `containerLogMaxFiles`，預設值與可調範圍以該版本的 kubelet 文件為準。Pod 上沒有 Docker 的 `--log-opt`，應用程式只管寫 stdout。
- `kubectl logs` 只讀得到最新的那個檔案；輪替出去的、Pod 刪除後的 log，要靠 Fluent Bit 這類 DaemonSet 收到叢集外，見 [Kubernetes 節點維護與備份](#/skill/k8s-node-maintenance)。
- 程式自己寫進容器裡的 log 檔，既不會被輪替，也不會被收集。gunicorn 的 access log 用 `--access-logfile -` 寫到 stdout；Python 在非終端機時緩衝 stdout 的問題，見 [日誌、錯誤處理與設定](#/skill/logging-config)。

## 以非 root 執行

`docker inspect --format '{{.Config.User}}' billing-api` 印出空字串，或 `docker exec billing-api id` 印出 `uid=0(root)`，就是以 root 執行；沒有開 user namespace 重新對應時，它就是主機的 UID 0（見 [Docker：image、container、layer](#/skill/docker-basics)）。在兩個 target 共用的階段建立使用者，兩個映像就都以非 root 執行（建置階段見 [幫 Python 專案寫好 Dockerfile](#/skill/dockerfile-python)）：

```dockerfile
FROM python:3.12-slim AS base
# 套件名稱依基底映像的 Debian 版本而定，照現有 Dockerfile 的清單
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpango-1.0-0 libpangocairo-1.0-0 cups-client fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
# 沒有家目錄：字型快取等需要寫入的東西放 /tmp
ENV HOME=/tmp XDG_CACHE_HOME=/tmp/.cache
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY billing/ ./billing/
COPY payment_server.py ./
# 數字 UID：Kubernetes 的 runAsNonRoot 才能確認不是 root
USER 10001:10001

FROM base AS api
CMD ["gunicorn", "-w", "1", "--threads", "50", "--keep-alive", "75", "-b", "0.0.0.0:8000", "billing.wsgi:app"]

FROM base AS payment
CMD ["python", "payment_server.py"]
```

改成非 root 之後，要處理程式寫檔的地方：

- **暫存檔**：產生到一半的 PDF 用 `tempfile`（預設在 `/tmp`），不寫在 `/app` 底下；程式碼目錄維持 root 擁有、只能讀。
- **要保留的檔案**：放 volume。既有的 volume 是 root 寫的，換 UID 前用同一個映像改一次擁有者：`docker run --rm --user 0 -v billing-data:/data harbor.example.org/billing/api:4.12.0 chown -R 10001:10001 /data`。
- **字型快取**：fontconfig 找不到可寫的快取目錄時會印 `Fontconfig error: No writable cache directories`，每次啟動都重新掃描字型。建置時先 `fc-cache -f`，執行時把 `HOME`、`XDG_CACHE_HOME` 指到 `/tmp`。
- **找出漏掉的地方**：測試環境加 `--read-only --tmpfs /tmp`，程式寫到別處會立刻得到 `Read-only file system`。

Kubernetes 上，namespace 套用 Pod Security 的 `restricted` 等級時，以 root 執行的 Pod 會被擋下；securityContext 的寫法見 [Kubernetes 實作：設定、探針與資源](#/skill/k8s-config-probes)，namespace 的標籤與導入順序見 [Kubernetes 多租戶](#/skill/k8s-multi-tenancy)。

## Docker Desktop 的授權

Docker Desktop 是 Windows、macOS 與 Linux 上的桌面應用程式，受 Docker 的訂閱服務合約（Docker Subscription Service Agreement）規範：

- 可以免費使用的情況：員工少於 250 人**而且**年營收少於 1,000 萬美元的組織、個人使用、教育用途、非商業的開源專案。超過這個範圍的商業使用需要付費訂閱。
- Docker 官方 FAQ 另外寫明，政府機關（Government Entities）不購買訂閱就不能使用 Docker Desktop。
- 醫院的員工數通常超過 250 人，公立醫院還可能落在政府機關的定義裡。開發機要用 Docker Desktop（包括用它跑本機的 kind 叢集），先向院方確認已經有授權。
- Linux 伺服器上用套件安裝的 Docker Engine 屬於開源的 Moby 專案，Docker 官方說明 Desktop 的條款沒有改變 Docker Engine 等開源專案的授權。Linux 版的 Docker Desktop 則同樣適用訂閱條款。
- 條款會改，最新內容以 Docker 官方的授權說明與 FAQ 為準。

不用 Docker Desktop 時的替代方案：

| 工具 | 定位 |
|---|---|
| Rancher Desktop | SUSE 維護的開源桌面工具，執行環境可選 containerd（搭配 nerdctl）或 dockerd（搭配 docker 指令），內建單節點的 k3s |
| Podman Desktop | 開源的圖形介面，底層是 Podman，也能建立 kind 叢集 |
| WSL 2 裡的 Docker Engine | Windows 開發機在 WSL 2 的 Linux 發行版裡直接安裝 Docker Engine |

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| Kubernetes 節點上 `docker: command not found`；`crictl` 警告沒有設定 endpoint | 1.24 起節點用 containerd 或 CRI-O；`crictl` 不知道要連哪一個 | 改用 `crictl`，在 `/etc/crictl.yaml` 設定 `runtime-endpoint` |
| 改成非 root 後 `PermissionError: [Errno 13] Permission denied` | 寫入 root 擁有的目錄，或 volume 裡是 root 寫的舊檔 | 寫 `/tmp` 或 volume；volume 一次性 `chown` |
| `Fontconfig error: No writable cache directories`，每次啟動都重新掃描字型 | 非 root 的使用者沒有家目錄，fontconfig 找不到可寫的快取目錄 | 建置時先 `fc-cache -f`；執行時把 `HOME`、`XDG_CACHE_HOME` 指到 `/tmp` |
| 加了 `--read-only --tmpfs /tmp` 之後 `Read-only file system` | 程式寫到 `/tmp` 以外的地方 | 暫存檔改用 `tempfile`，要保留的檔案放 volume |

## 動手

1. 依 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建好 kind 叢集，用 `docker exec -it clinic-control-plane crictl ps` 找到 `clinic-api` 的容器，執行 `crictl logs` 並看 `/var/log/pods/` 的檔案。
2. 對手邊的一個容器執行 `docker inspect --format '{{.Config.User}}'` 與 `docker exec <容器> id`，確認它是不是以 root 執行。
3. 用 `--read-only --tmpfs /tmp` 再啟動同一個映像，看程式有沒有因為寫到別處而得到 `Read-only file system`。
4. 列出團隊開發機上用來跑容器的桌面工具，對照 Docker Desktop 的免費使用條件，寫下哪幾台要有授權或改用替代方案。
