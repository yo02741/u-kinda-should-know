## 兩個 job 都拉不到外部映像：限流與防火牆

本課接在 [私有映像倉庫：Harbor 的專案、機器人帳號與 CI 推送](#/skill/container-registry) 之後，以 Harbor 2.x 為準。`clinic-api` 的 pipeline 有兩個 job 拉不到外部映像：

| job | 訊息 | 原因 |
|---|---|---|
| `build-base`：`FROM python:3.12-slim` | `429 Too Many Requests`、`toomanyrequests: You have reached your unauthenticated pull rate limit` | 全院經由同一個對外 IP 出去，Docker Hub 未登入的拉取次數依來源 IP 計算 |
| `build-image`：`COPY --from=ghcr.io/astral-sh/uv:0.11.32` | `dial tcp ...:443: i/o timeout` | 對外規則收緊，ghcr.io 不在白名單裡 |

## 三種把外部映像帶進院內的做法

| | 代理快取專案 | 複製（replication） | 同步 job（skopeo、crane） |
|---|---|---|---|
| 運作方式 | 第一次有人拉時向上游取並快取；再拉時先用 HEAD 檢查上游有沒有更新 | Harbor 依規則從外部 registry 拉進來，或推到另一座 Harbor；手動、排程或推送事件觸發 | 自己維護清單，排程複製 |
| 院內有哪些映像 | 有人拉過的 | 符合篩選條件的 | 清單上列的 |
| 上游斷線時 | 快取過的照樣能拉，沒快取過的拉不到 | 複製過的都在 | 同步過的都在 |
| 適合 | 受限網路：Harbor 能連外，節點與 Runner 不能 | 兩座 Harbor 之間，例如正式與災備 | 斷網環境；映像要先審核再放行 |

代理快取專案（proxy cache）在 Harbor 2.1 加入，官方建議用 2.1.1 以上以免被 Docker Hub 限流。系統管理者先建一個指向上游的 registry endpoint，建專案時打開 Proxy Cache 選它。上游可以是 Docker Hub、GitHub Container Registry、Quay、另一座 Harbor 等（清單依版本而定）。

- 代理快取專案不能推送。新建時 Harbor 預設帶一條 7 天的保留規則。
- endpoint 的上游帳號拉得到的，有這個代理專案權限的人都拉得到，上游帳號只給需要的權限；用 Docker Hub 帳號設定，額度也比匿名高。
- Docker Hub 的官方映像要寫出 `library/`：`python:3.12-slim` 的完整名稱是 `docker.io/library/python:3.12-slim`，院內位址是 `harbor.example.org/dockerhub-proxy/library/python:3.12-slim`。

複製要注意：官方文件寫明不同版本的 Harbor 之間的複製不支援，兩座要一起升級；手動與排程觸發不會複製刪除。

## 改寫 `FROM`、`COPY --from` 與 CI 的映像

```dockerfile
# base/python-informix/Dockerfile：資訊室的基底映像，每月重建
FROM harbor.example.org/dockerhub-proxy/library/python:3.12-slim
# ……安裝 Informix 用戶端（略）
```

```dockerfile
# clinic-api/Dockerfile
FROM harbor.example.org/base/python-informix:3.12-slim-2026.11 AS build
COPY --from=harbor.example.org/ghcr-proxy/astral-sh/uv:0.11.32 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

FROM harbor.example.org/base/python-informix:3.12-slim-2026.11
# build 是上面的階段名稱，不是映像，不用改
COPY --from=build /app/.venv /app/.venv
```

- 需要可重現時，基底映像再釘上 digest（`…:3.12-slim-2026.11@sha256:…`），由 Renovate 這類工具提出更新，見 [依賴與供應鏈安全](#/skill/supply-chain)。
- CI 的 `image:` 與 `services:` 一樣改成院內位址（範例見 [私有映像倉庫：Harbor 的專案、機器人帳號與 CI 推送](#/skill/container-registry) 的 CI 推送一章）。GitLab Runner 自己的 helper 映像預設也從外部下載，斷網時要在 Runner 設定裡指向院內。

| 訊息或現象 | 原因 | 怎麼修 |
|---|---|---|
| `toomanyrequests: You have reached your … pull rate limit` | Docker Hub 的拉取次數用完 | 改走代理快取，endpoint 用 Docker Hub 帳號 |
| `x509: certificate signed by unknown authority` | 那個 containerd 或 Docker（含 CI 的 dind）不信任院內 CA | 每台節點與 dind 都放院內 CA |

:::stop 讀到這裡可以先停：知道代理快取、複製與同步 job 的差別，會把 Dockerfile 與 CI 的外部映像改成院內位址。後面的 Docker Hub 計次方式、叢集的 pull secret 與院內 CA、斷網環境的映像清單與搬運，在叢集要拉私有映像或準備斷網叢集時再回來讀。

## Docker Hub 的拉取次數怎麼算

開頭兩個 job 的 `image: docker:27` 與 `services: docker:27-dind` 也來自 Docker Hub，只是 Runner 上剛好有快取。

Docker Hub 對未登入的使用者與免費帳號有拉取次數上限，付費方案沒有次數上限（另有合理使用規範）。數字與計算的時間窗 Docker 調整過好幾次，以官方文件的 Docker Hub usage and limits 頁面為準。對院內影響最大的是計算方式：

- 未登入的次數依來源 IP 計算（IPv6 以 /64 網段計）。全院經由同一個出口 IP 時，大家共用一份額度。
- 計算的是取得 manifest 的請求。只問 manifest 有沒有變的 HEAD 請求不算，Harbor 2.1.1 起的代理快取用 HEAD 檢查上游。

ghcr.io、quay.io、registry.k8s.io（Kubernetes 元件的官方來源）各有自己的使用規範。

## 叢集怎麼拉院內的映像

### pull secret 掛在 ServiceAccount 上

私有專案的映像要帶登入資訊才拉得到。Kubernetes 官方建議用 Pod 的 `imagePullSecrets`：Secret 的型別是 `kubernetes.io/dockerconfigjson`，而且要和 Pod 在同一個 namespace。

```bash
# 機器人帳號的名稱有 $，用單引號；正式環境的 Secret 由秘密管理流程建立
kubectl create secret docker-registry harbor-pull -n clinic \
  --docker-server=harbor.example.org \
  --docker-username='robot$clinic+k8s-pull' \
  --docker-password="$(cat robot-clinic-k8s-pull.secret)"
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: clinic-api
  namespace: clinic
automountServiceAccountToken: false
imagePullSecrets:
  - name: harbor-pull          # 之後用這個 ServiceAccount 建立的 Pod 會自動帶上
---
# Deployment 的 Pod 範本（節錄）
spec:
  template:
    spec:
      serviceAccountName: clinic-api
      containers:
        - name: api
          image: harbor.example.org/clinic/api@sha256:c2f8…   # CI 交出來的 IMAGE_REF
```

- 寫在 ServiceAccount 上，之後建立的 Pod 會自動帶上，已經存在的 Pod 不會。
- 讀得到這個 Secret 的人就有拉取權限，誰讀得到見 [Kubernetes 權限](#/skill/k8s-rbac-tenancy)。機器人帳號只給拉取，外洩時的影響就只有拉 `clinic` 的映像。
- 另外兩種做法：在每台節點的容器執行環境設定登入資訊（所有 Pod 都能用），或用 kubelet 的 credential provider 外掛動態取得。

節點上的快取也牽涉權限：`imagePullPolicy: IfNotPresent` 時，節點上已有的映像以前不會再驗證，同一台節點上沒帶 pull secret 的 Pod 也能用，多租戶叢集要靠 AlwaysPullImages admission plugin 擋。Kubernetes 1.33 加入 `KubeletEnsureSecretPulledImages`（alpha），1.35 起為 beta 且預設開啟：kubelet 會確認 Pod 帶的憑證拉過這個映像；不是 kubelet 拉的映像（例如事先匯入節點的）預設不檢查，由 kubelet 設定的 `imagePullCredentialsVerificationPolicy` 決定。

### 節點要信任院內 CA

拉映像的是節點上的 containerd。Harbor 用院內 CA 簽的憑證時，每台節點都要信任院內 CA：裝進作業系統的信任清單，或在 containerd 的 registry 設定指定 `ca`，並寫進節點的建置流程；CI 的 dind 與開發機的 Docker 也一樣。憑證見 [HTTPS 憑證：要買哪種、怎麼續](#/skill/https-certificates)。

```toml
# /etc/containerd/certs.d/harbor.example.org/hosts.toml
# containerd 1.5 起的寫法；config.toml 要把 registry 的 config_path 設成 /etc/containerd/certs.d
# （containerd 2.x 的設定區段是 plugins."io.containerd.cri.v1.images".registry）
server = "https://harbor.example.org"

[host."https://harbor.example.org"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/containerd/certs.d/harbor.example.org/hospital-root-ca.crt"
```

### 鏡像設定：只講概念

containerd 可以替某個 registry 設定鏡像（mirror）：manifest 寫 `docker.io/library/postgres:16`，containerd 實際向院內位址拿。設定放在 `certs.d/docker.io/hosts.toml`，`server` 設成院內位址時就只用院內、不回上游。Harbor 代理快取的路徑多一段專案名稱，拿它當 mirror 要讓 containerd 用帶專案名稱的路徑（`override_path`），細節以 containerd 與 Harbor 的文件為準。

鏡像不用改 manifest，代價是看不出 manifest 依賴外部來源，換一台沒設鏡像的節點就壞，斷網清單也容易漏列。自己維護的 manifest 明寫院內位址，鏡像當成第三方 chart 漏改時的備援。拉不到映像時的排查順序見 [Kubernetes 排錯](#/skill/k8s-troubleshooting)。

## 斷網環境：列清單、複製、搬運

### 列出需要的映像

斷網叢集只拉得到院內有的映像。清單要從每一個會拉映像的地方列：

| 類別 | 從哪裡列 | 容易漏的 |
|---|---|---|
| 應用程式 | 自己的 manifest、Kustomize overlay 的 `images` | CronJob、Job、initContainers |
| 基底與建置 | Dockerfile 的 `FROM` 與 `COPY --from` | 多階段建置裡的工具映像 |
| CI | `.gitlab-ci.yml` 的 `image:` 與 `services:` | Runner 的 helper 映像 |
| Kubernetes 本身 | `kubeadm config images list --kubernetes-version <版本>` | 下一個要升級的版本 |
| 附加元件 | CNI、CSI、Ingress 或 Gateway controller、cert-manager、監控、Velero 的安裝檔 | 元件執行時才建立的 Pod 所用的映像，寫在啟動參數或設定裡 |
| Helm chart | `helm template` 的輸出；chart 本身也要進院內（Harbor 能存 OCI 格式的 chart） | 依 values 才啟用的子元件 |

下面的程式從幾份 manifest 與 `kubeadm config images list` 的輸出找出所有映像，補上省略的 registry 與 tag 後去重，標出還在用 `latest`、還指向外部，以及只出現在啟動參數裡的：

```python run
import re

INTERNAL = "harbor.example.org"

# 幾份要帶進斷網環境的 manifest（版本為示意）
manifests = {
    "clinic/base/deployment.yaml": """
spec:
  template:
    spec:
      containers:
        - name: api
          image: harbor.example.org/clinic/api:3f9c2a1b
""",
    "clinic/overlays/kind/postgres.yaml": """
      containers:
        - name: postgres
          image: postgres:16
""",
    "clinic/report-cronjob.yaml": """
          initContainers:
            - name: wait-db
              image: "busybox"
          containers:
            - name: report
              image: harbor.example.org/clinic/report:latest
""",
    # helm template cert-manager … 的輸出（節錄）
    "helm/cert-manager.yaml": """
      containers:
        - name: cert-manager-controller
          image: "quay.io/jetstack/cert-manager-controller:v1.19.1"
          args:
            - --acme-http01-solver-image=quay.io/jetstack/cert-manager-acmesolver:v1.19.1
""",
    "helm/monitoring.yaml": """
      containers:
        - name: grafana
          image: docker.io/grafana/grafana:12.2.1
        - name: sidecar
          image: quay.io/kiwigrid/k8s-sidecar@sha256:4f6c0d9a1b2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a
""",
}
# kubeadm config images list 的輸出（節錄）：控制平面的元件也是映像
kubeadm_images = """
registry.k8s.io/kube-apiserver:v1.35.2
registry.k8s.io/pause:3.10.1
registry.k8s.io/coredns/coredns:v1.12.1
"""

IMAGE_FIELD = re.compile(r"^\s*(?:-\s*)?image:\s*['\"]?([^'\"\s]+)")
IMAGE_ARG = re.compile(r"-image=([^\s'\"]+)")   # 寫在啟動參數裡的映像

def parse(ref):
    """把映像名稱拆成 (registry, repository, tag, digest)，補上省略的部分"""
    name, _, digest = ref.partition("@")
    first, _, rest = name.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        registry, repo = first, rest
    else:
        registry, repo = "docker.io", name
        if "/" not in repo:
            repo = "library/" + repo          # 官方映像在 library 底下
    tag = None
    if ":" in repo.rsplit("/", 1)[-1]:
        repo, tag = repo.rsplit(":", 1)
    if tag is None and not digest:
        tag = "latest"                         # 什麼都沒寫，就是 latest
    return registry, repo, tag, digest or None

found = {}   # 完整名稱 → 出現在哪些檔案、是不是從參數裡找到的
sources = dict(manifests, **{"kubeadm config images list": kubeadm_images})
for path, text in sources.items():
    for line in text.splitlines():
        m = IMAGE_FIELD.match(line)
        refs = [(m.group(1), False)] if m else []
        if not m and path.startswith("kubeadm") and line.strip():
            refs = [(line.strip(), False)]
        refs += [(r, True) for r in IMAGE_ARG.findall(line)]
        for ref, from_arg in refs:
            reg, repo, tag, digest = parse(ref)
            full = f"{reg}/{repo}" + (f":{tag}" if tag else "") + (f"@{digest[:19]}…" if digest else "")
            entry = found.setdefault(full, {"files": set(), "arg": from_arg, "reg": reg, "tag": tag, "digest": digest})
            entry["files"].add(path)

print(f"共 {len(found)} 個不重複的映像\n")
for full, e in sorted(found.items()):
    flags = []
    if e["tag"] == "latest":
        flags.append("latest")
    if e["reg"] != INTERNAL:
        flags.append("外部，要同步")
    if e["arg"]:
        flags.append("在參數裡")
    print(f"{full}")
    print(f"    {'、'.join(flags) or '院內、固定版本'}　← {', '.join(sorted(e['files']))}")

to_sync = sorted(f for f, e in found.items() if e["reg"] != INTERNAL)
print(f"\n要同步進院內的外部映像：{len(to_sync)} 個；用 latest 的：{sum(e['tag'] == 'latest' for e in found.values())} 個")
```

- `busybox` 沒寫 registry 也沒寫 tag，完整名稱是 `docker.io/library/busybox:latest`。今天同步進來的 `latest`，和下次同步的不會是同一個。
- `clinic/report:latest` 在院內，但 tag 會移動，回退時沒有版本可以指。
- `cert-manager-acmesolver` 不在任何 `image:` 欄位，是 controller 執行時才拿來建 Pod 的。程式靠比對 `-image=` 參數找到它，換一種寫法就會漏。

從 manifest 推出來的清單總會漏幾個，最後要在一座同樣斷網的測試叢集裡完整安裝一次，看 `kubectl get events -A` 有沒有拉取失敗。

### 複製：保留 digest 與多架構

多架構映像多一層索引（image index，舊稱 manifest list），再指向每個架構的 manifest。

skopeo 與 crane 都不需要 Docker daemon，直接在 registry 之間搬 manifest 與 blob。指令只示意，旗標以各工具的文件為準：

```bash
# 在能連外、也能連院內 Harbor 的跳板機上執行
# skopeo：--all 複製每個架構與多架構索引；--preserve-digests 在 digest 保不住時直接失敗
skopeo copy --all --preserve-digests \
  docker://quay.io/jetstack/cert-manager-controller:v1.19.1 \
  docker://harbor.example.org/k8s/jetstack/cert-manager-controller:v1.19.1

# crane：預設複製所有架構，並保留 digest
crane copy registry.k8s.io/pause:3.10.1 harbor.example.org/k8s/pause:3.10.1

# 兩邊的 digest 要一樣
crane digest registry.k8s.io/pause:3.10.1
crane digest harbor.example.org/k8s/pause:3.10.1
```

- 用 `docker pull`、`docker tag`、`docker push` 搬，或 skopeo 沒加 `--all`，只會拿到執行機器那個架構的一份，多架構索引沒有過來。manifest 照上游用索引的 digest 釘版本時，院內會回 `manifest unknown`；跳板機是 arm64 筆電時，搬到的還是 arm64 那一份。
- 院內路徑照上游的路徑放在專案底下（`harbor.example.org/k8s/<上游路徑>`），改寫規則才單純。kubeadm 的 `imageRepository` 改成院內位址後，各元件的完整路徑以 `kubeadm config images list --image-repository harbor.example.org/k8s` 的輸出為準。

### 跨網段搬運

完全隔離的網段沒有一台機器同時連得到兩邊，映像要先存成檔案，經核可的管道搬進去：

```text
可連外的區域                     受控管道                       斷網區域
依清單存成目錄             →   雜湊清單、掃描、核可        →   核對雜湊、推進 Harbor
（skopeo sync --dest dir）      經核可的媒體或單向傳輸           → Harbor 掃描 → 測試叢集安裝驗證
```

```bash
# 1. 可連外的跳板機：依清單把映像存成目錄（清單格式與目錄命名見 skopeo-sync 的文件）
skopeo sync --all --src yaml --dest dir sync.yaml /transfer/images
# 2. 產生每個檔案的雜湊，跟著媒體一起送審
cd /transfer && find images -type f -exec sha256sum {} + > images.sha256
# 3. 斷網區域：核對雜湊後推進院內 Harbor
cd /transfer && sha256sum -c images.sha256 && \
  skopeo sync --all --src dir --dest docker images harbor.example.org/k8s
```

crane 也能做（`crane pull --format=oci`、`crane push`）。哪些映像能進來、誰核可、多久搬一次，寫成流程，見 [受監管環境的變更管理](#/skill/change-management)。Trivy 的弱點資料庫也走同一條路。

### 升級前先同步

Kubernetes 升級前，新版本的控制平面映像、相容版本的 CNI、CSI、controller 與 Helm chart 一次搬進來，先在斷網的測試叢集升一次，升級的順序見 [Kubernetes 叢集維運](#/skill/k8s-operations)。套件庫等其他下載來源見 [地端、雲端還是混合雲](#/skill/hosting-models) 的斷網一節。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本與工具而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 怎麼修 |
|---|---|---|
| `toomanyrequests: You have reached your … pull rate limit` | Docker Hub 的拉取次數用完 | 改走代理快取，endpoint 用 Docker Hub 帳號 |
| 用 digest 釘版本的映像拉取時 `manifest unknown` | 複製時沒有帶多架構索引 | `skopeo copy --all --preserve-digests` 或 `crane copy` 重新複製，比對 digest |
| `x509: certificate signed by unknown authority` | 那個 containerd 或 Docker（含 CI 的 dind）不信任院內 CA | 每台節點與 dind 都放院內 CA |
| 節點故障後重排的 Pod 停在 `ImagePullBackOff`，其他 Pod 正常 | pull secret 的機器人帳號過期、映像被保留規則刪了、或新弱點觸發阻擋 | `describe pod` 的 Events，見 [Kubernetes 排錯](#/skill/k8s-troubleshooting) |

## 動手

1. 執行映像清單的程式，把 `busybox` 改成 `busybox:1.37`、把報表的 tag 改成 commit SHA，看標記怎麼變；再貼一份 `helm template` 的輸出進去。
2. 做本課的程式題：[把 Dockerfile 的外部映像改指院內的代理快取](#/exercise/container-registry-2)。
3. 依 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建好 kind 叢集，照 kind 文件的 local registry 做法起一個 `registry:2`。用 `crane copy` 把 `postgres:16` 複製到 `mirror-a/postgres:16`、用不加 `--all` 的 `skopeo copy` 複製到 `mirror-b/postgres:16`，三邊各跑 `crane digest`。再把 overlay 的 `postgres:16` 改成本機 registry 加上游的 digest，分別指向兩邊，看哪一個拉得起來。
4. 有測試用的 Harbor 時：建一個只能拉取的機器人帳號，在 kind 的節點（`docker exec` 進節點容器）放院內 CA 與 `hosts.toml`，建 pull secret 掛到 `clinic` 的 ServiceAccount 並部署。把 Secret 的密碼改錯、刪掉 Pod，看 Events 的訊息。
