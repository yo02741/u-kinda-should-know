## 叢集上線滿一年的早上：憑證到期，版本也停止修補

院內第一座 Kubernetes 叢集在 2025 年 11 月 12 日用 kubeadm 建好：三台控制平面、三台 worker，跑門診掛號的 `clinic-api`。一年來沒有人動過它。2026 年 11 月 16 日早上，值班的工程師要查一個 Pod：

```bash
$ kubectl get pods -n clinic
Unable to connect to the server: tls: failed to verify certificate: x509: certificate has expired or is not yet valid: current time 2026-11-16T08:12:05+08:00 is after 2026-11-12T01:40:22Z
```

同一天資安組轉來一則 Kubernetes 的弱點公告，修補版只出在 1.35、1.36、1.37。叢集是 1.34，而 1.34 在 2026 年 10 月 27 日已經停止修補。

兩件事的原因相同：叢集上線後，沒有人負責它的生命週期。

- **憑證到期**：kubeadm 建叢集時產生的元件憑證（含 `admin.conf` 裡給 `kubectl` 用的那一張）預設效期 1 年，CA 預設 10 年。
- **版本落後**：上游大約每 4 個月出一個次版本，每版修補約 14 個月。一年沒升級，叢集就落到沒有修補的版本。

`kubeadm upgrade` 預設會順便更新它管理的憑證，所以照節奏升級的叢集，通常不會碰到第一個問題。

## 版本節奏與版本差異政策：先控制平面，再節點

版本號是 `1.次版本.修補版`，例如 1.35.9。上游的規則（以 [kubernetes.io/releases](https://kubernetes.io/releases/) 為準）：

- 大約每 4 個月出一個次版本（minor），同時維護最近三個。
- 每個次版本約有 14 個月的修補：前 12 個月是一般支援，最後 2 個月是維護模式，只收安全修補與嚴重問題的修正。
- 修補版大約每月一次；同一個次版本內換修補版比較輕。

2026 年 11 月的狀態（示意，日期以官方頁面為準）：

| 次版本 | 發行日 | 停止修補 |
|---|---|---|
| 1.34 | 2025-08-27 | 2026-10-27（已停止） |
| 1.35 | 2025-12-17 | 2027-02-28 |
| 1.36 | 2026-04-22 | 2027-06-28 |
| 1.37 | 2026-08-26 | 2027-10-28 |

所以叢集每年至少升級一次。控制平面一次只能升一個次版本：1.34 到 1.37 要依序升三次，每一次都要做完整的檢查與節點輪替。

升級途中，叢集裡同時有新舊版本。各元件之間可以差多少（摘要，以官方 [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/) 為準）：

| 元件 | 相對於 API server |
|---|---|
| 多台 API server 之間 | 最多差 1 個次版本 |
| controller-manager、scheduler | 不能比 API server 新，最多舊 1 個次版本 |
| kubelet、kube-proxy | 不能比 API server 新，最多舊 3 個次版本（1.25 以前的版本只能舊 2 個） |
| kubectl | 新或舊 1 個次版本以內 |

這張表決定了升級順序：

- **先控制平面，再節點**。kubelet 不能比 API server 新，節點不能先升。
- kubelet 可以舊 3 個次版本，節點可以分批升，不必和控制平面同一晚做完，但仍要盡快跟上。用 kubeadm 時，節點升級還要符合 kubeadm 本身的版本規定（以 kubeadm 文件為準）。
- 管理者電腦與 CI 裡的 `kubectl` 也要跟著換。

## 用 kubeadm 升一個次版本

以 kubeadm 從 1.34 升 1.35 為例（細節以官方的 [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/) 為準，`x` 換成要升的修補版）：

```bash
# 0. 事前：etcd 快照（見「節點維護與備份」那一課）、變更單核准、測試叢集演練過同一個版本

# 1. 每台節點：套件來源換成 1.35 的套件庫（pkgs.k8s.io 每個次版本一個庫）；斷網環境指向院內鏡像
sudo sed -i 's#/v1.34/#/v1.35/#' /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update

# 2. 第一台控制平面：先升 kubeadm，看計畫，再套用
sudo apt-mark unhold kubeadm && sudo apt-get install -y kubeadm='1.35.x-*' && sudo apt-mark hold kubeadm
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.x     # 控制平面元件、etcd、CoreDNS、kube-proxy，並更新這台的憑證

# 3. 其他控制平面：一樣先升 kubeadm，再執行
sudo kubeadm upgrade node

# 4. 每台控制平面依序：drain → 升 kubelet 與 kubectl → 重啟 kubelet → uncordon
kubectl drain k8s-cp-1 --ignore-daemonsets
sudo apt-mark unhold kubelet kubectl && sudo apt-get install -y kubelet='1.35.x-*' kubectl='1.35.x-*' && sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon k8s-cp-1

# 5. worker 一台一台：升 kubeadm → kubeadm upgrade node → drain → 升 kubelet → 重啟 → uncordon
```

`kubeadm upgrade plan` 檢查能不能升、列出每個元件的新舊版本；`apply` 中途失敗可以重跑。升級前要先找出目標版本不再提供的 API：叢集升到不再提供某個 apiVersion 的版本之後，用舊寫法的 manifest 一套用就失敗：

```text
error: resource mapping not found for name: "clinic-api" namespace: "clinic" from "pdb.yaml": no matches for kind "PodDisruptionBudget" in version "policy/v1beta1"
ensure CRDs are installed first
```

:::stop 讀到這裡可以先停：會說出憑證與版本各自多久到期，依版本差異政策排出一次升一個次版本的順序。後面的元件、發行版比較、被移除的 API 與升級路徑的程式，在規劃升級前回來讀。

## 維運要顧的元件

| 元件 | 在哪裡跑 | 停了會怎樣 | 維運要顧 |
|---|---|---|---|
| API server | 控制平面；kubeadm 用靜態 Pod 跑 | `kubectl`、CI 部署、所有控制器都連不上；已經在跑的容器不受影響 | 憑證、升級、多台時前面的負載平衡 |
| etcd | 控制平面（kubeadm 預設與 API server 同機） | 叢集狀態讀不到也寫不進去，API server 跟著不能用 | 快照備份、成員數用奇數、磁碟延遲、資料庫大小 |
| scheduler | 控制平面 | 新的 Pod 停在 Pending | 憑證、升級 |
| controller-manager | 控制平面 | 副本數不再被維持，節點故障沒人處理 | 憑證、升級 |
| kubelet | 每個節點，systemd 服務 | 節點變成 NotReady，上面的 Pod 過一段時間被移走 | 版本不能比 API server 新、憑證輪替、磁碟空間 |
| 容器執行環境 | 每個節點，systemd 服務 | 這個節點上的容器都跑不了 | 版本、映像占用的磁碟 |
| kube-proxy | 每個節點，DaemonSet | 這個節點上的 Service 規則不再更新 | 跟著叢集版本升級 |

kubeadm 的控制平面元件是**靜態 Pod**：kubelet 直接讀 `/etc/kubernetes/manifests/` 的 YAML 啟動它們，`kubectl delete pod` 重啟不了。API server 起不來時，要登入控制平面節點，直接看 kubelet 與容器執行環境：

```bash
journalctl -u kubelet --since "10 min ago"   # kubelet 的 log：憑證、連不上 API server、磁碟壓力
sudo crictl ps -a                            # 節點上所有容器，包含已經結束的
sudo crictl logs <容器 ID>                    # 例如 kube-apiserver 為什麼一直重啟
sudo crictl images                           # 節點上的映像
```

Kubernetes 1.24 起移除了 dockershim，節點上的容器執行環境是 containerd 或 CRI-O 這類實作 CRI（Container Runtime Interface）的程式。用 Docker 建的映像照樣能跑（映像格式是共通的 OCI 標準），但節點上多半沒有 docker 指令，排查容器用 `crictl`。

叢集要先裝哪些周邊元件，見 [導入 Kubernetes 前要準備什麼](#/skill/k8s-readiness)。

## 發行版怎麼選

上游 Kubernetes 只是一組元件。能上線的叢集還要有作業系統、安裝與升級工具、網路與儲存外掛、安全設定，以及出事時找得到的人，發行版的差別在這些由誰負責：

| 發行版 | 定位 | 支援與修補 | 升級工具 | 預設安全設定 | 人力 |
|---|---|---|---|---|---|
| kubeadm | 上游的安裝工具，只建出最小可用的叢集 | 社群；商業支援要另外找 | `kubeadm upgrade`，順序自己排 | 上游預設，強化自己做 | 最多：CNI、Ingress、儲存、監控、備份都自己選、自己裝 |
| RKE2 | SUSE（Rancher）的發行版，主打安全與合規 | 開源，可向 SUSE 買支援 | 換執行檔重啟；可用 system-upgrade-controller 自動依序升級 | 設計成預設通過大部分 CIS 基準項目 | 中等：內建 CNI、Ingress、定期 etcd 快照 |
| k3s | 同一家的輕量版，單一執行檔 | 同上 | 同上 | 要依強化指南調整 | 少；適合測試、邊緣與小型環境 |
| OpenShift | Red Hat 的企業平台，內建監控、registry、登入整合 | Red Hat 訂閱，自己的生命週期 | 內建更新頻道，節點作業系統一起升 | 最嚴：預設以非 root 的隨機 UID 執行容器 | 平台本身吃資源，要學它的做法（Route、SCC、Operator） |

Rancher 不是發行版，是管理多座叢集的平台：統一登入與權限、建立 RKE2 或 k3s 叢集、匯入其他叢集，在同一個介面看狀態與升級，叢集分成多座之後才值得評估。大量使用 VMware 的機房，vSphere 也有整合的 Kubernetes 方案（產品名稱近年改過幾次），支援跟著 VMware 的合約走。

評估時先問：弱點公告出來誰出修補版、斷網環境的安裝與升級有沒有官方文件、團隊有幾個人能處理 Linux 與儲存的問題。用 kubeadm 時，這些答案都是「我們自己」。

地端、雲端與混合雲的取捨見 [地端、雲端還是混合雲](#/skill/hosting-models)；雲端代管做掉了哪些事，見 [導入 Kubernetes 前要準備什麼](#/skill/k8s-readiness)。

## 升級前：找出被移除的 API

beta 版的 API 在正式版出來後會被標成 deprecated，幾個版本後停止提供。

已經在叢集裡的物件不會消失，API server 改用新的版本提供它們。會壞的是 Git 裡的 manifest、Helm chart、CI 的 `kubectl apply`，以及還在呼叫舊 API 的程式與 operator。

幾個常見的例子（摘自官方的 [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)，完整清單以官方為準）：

| 停止提供的版本 | 物件 | 舊的 apiVersion | 改用 |
|---|---|---|---|
| 1.22 | Ingress | `extensions/v1beta1`、`networking.k8s.io/v1beta1` | `networking.k8s.io/v1`，`backend` 的寫法也變了 |
| 1.25 | CronJob | `batch/v1beta1` | `batch/v1` |
| 1.25 | PodDisruptionBudget | `policy/v1beta1` | `policy/v1`；空的 `selector` 從「選不到」變成「選到全部」 |
| 1.25 | PodSecurityPolicy | `policy/v1beta1` | 沒有直接替代，改用 Pod Security Admission |
| 1.26 | HorizontalPodAutoscaler | `autoscaling/v2beta2` | `autoscaling/v2` |
| 1.32 | FlowSchema、PriorityLevelConfiguration | `flowcontrol.apiserver.k8s.io/v1beta3` | `flowcontrol.apiserver.k8s.io/v1` |

從網路上複製的範本與舊版 Helm chart 常常還是舊寫法。每次升級前，對著遷移指南裡目標版本那一節查三個地方：

- **叢集收到的請求**：API server 從 1.19 起把 deprecated API 的請求記在 `apiserver_requested_deprecated_apis` 指標（標籤 `removed_release` 是停止提供的版本），連不在 Git 裡的程式也抓得到。
- **Git 裡的 manifest 與 chart**：用掃描工具（例如 pluto、kubent）對目標版本比對，本課的程式題是最小的版本。
- **Helm release**：Helm 把安裝時的 manifest 存在叢集裡，release 沒重新部署，裡面還是舊的 apiVersion。

```text
$ kubectl apply -f hpa.yaml            # 在 1.25 的叢集上套用舊寫法：成功，但伺服器送回警告
Warning: autoscaling/v2beta2 HorizontalPodAutoscaler is deprecated in v1.23+, unavailable in v1.26+; use autoscaling/v2 HorizontalPodAutoscaler
horizontalpodautoscaler.autoscaling/clinic-api created

$ kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis   # 管理者：誰還在用
```

## kubeadm 升級的注意事項：憑證、斷網、周邊元件與回復

- `kubeadm upgrade` 預設會更新這台節點上的憑證（`--certificate-renewal=false` 關掉）。
- 斷網的院內環境，新版需要的映像（`kubeadm config images list` 列得出來）要先同步到院內的 registry，叢集設定的 `imageRepository` 指向它；其他下載來源見 [地端、雲端還是混合雲](#/skill/hosting-models) 的斷網一節。
- CNI、Ingress controller、CSI driver、監控、Velero 各有支援的版本範圍，控制平面升級前先確認。
- 控制平面降版沒有一般性的官方支援，升壞了的回復手段是用升級前的 etcd 快照與舊版元件重建，所以要先在測試叢集演練、記下時間。升級排進變更單，寫清楚維護時段、回復條件與步驟，見 [變更管理](#/skill/change-management)。

## 用程式排出升級路徑

下面用示意的版本資料，替開頭那座 1.34 的叢集排出到 1.37 的路徑與每一步的檢查，再檢查幾種升級途中的版本組合：

```python run
from datetime import date, timedelta

# 示意資料：發行日與停止修補日以 kubernetes.io/releases 為準
RELEASES = {
    "1.34": (date(2025, 8, 27), date(2026, 10, 27)),
    "1.35": (date(2025, 12, 17), date(2027, 2, 28)),
    "1.36": (date(2026, 4, 22), date(2027, 6, 28)),
    "1.37": (date(2026, 8, 26), date(2027, 10, 28)),
}
STEP_CHECKS = [
    "讀 {v} 的 release notes；掃描 manifest 與 Helm release 裡 {v} 不再提供的 apiVersion",
    "確認 CNI、Ingress controller、CSI driver、監控、Velero 支援 {v}",
    "etcd 快照，確認快照檔讀得出來",
    "套件來源換成 {v} 的套件庫；院內 registry 先同步 {v} 的映像",
    "測試叢集先演練 {prev} → {v}，記下花多久",
    "控制平面逐台升級，再一台一台 drain worker、升 kubelet、uncordon",
]


def minor(v):
    return int(v.split(".")[1])


def status(v, today):
    _, eol = RELEASES[v]
    if today > eol:
        return f"{eol} 已停止修補"
    return f"修補到 {eol}，還有 {(eol - today).days} 天"


def plan(current, target, today):
    print(f"目前 {current}（{status(current, today)}）")
    if minor(target) < minor(current):
        print("目標比目前舊：降版沒有一般性的官方支援")
        return
    path = [f"1.{m}" for m in range(minor(current) + 1, minor(target) + 1)]
    print(f"目標 {target}：控制平面要依序升 {len(path)} 次，{' → '.join([current] + path)}\n")
    prev = current
    for i, v in enumerate(path, 1):
        print(f"第 {i} 步 {prev} → {v}（{status(v, today)}）")
        for c in STEP_CHECKS:
            print("   - " + c.format(v=v, prev=prev))
        prev = v
    _, eol = RELEASES[target]
    print(f"\n升完之後：{target} 修補到 {eol}，下一次升級最晚在 {eol - timedelta(days=60)} 前做完（留兩個月緩衝）")


# 版本差異政策的摘要（以官方 Version Skew Policy 為準）
def skew_problems(state):
    api = [minor(v) for v in state["apiserver"]]
    newest, oldest = max(api), min(api)
    problems = []
    if newest - oldest > 1:
        problems.append("API server 之間差超過 1 個次版本")
    for name in ("controller-manager", "scheduler"):
        for v in state.get(name, []):
            if minor(v) > oldest:
                problems.append(f"{name} {v} 比最舊的 API server 新")
            elif minor(v) < newest - 1:
                problems.append(f"{name} {v} 落後 API server 超過 1 個次版本")
    for node, v in state.get("kubelet", {}).items():
        if minor(v) > oldest:
            problems.append(f"{node} 的 kubelet {v} 比 API server 新")
        elif minor(v) < newest - 3:
            problems.append(f"{node} 的 kubelet {v} 落後 API server 超過 3 個次版本")
    return problems


plan("1.34", "1.37", today=date(2026, 11, 16))

print("\n升級途中的版本組合：")
states = {
    "三台 API server 升了兩台": {
        "apiserver": ["1.35", "1.35", "1.34"], "controller-manager": ["1.34"], "scheduler": ["1.34"],
        "kubelet": {"k8s-node-1": "1.34", "k8s-node-2": "1.34"},
    },
    "有人先升了一台 worker": {
        "apiserver": ["1.34", "1.34", "1.34"],
        "kubelet": {"k8s-node-1": "1.35", "k8s-node-2": "1.34"},
    },
    "控制平面到 1.37，有一台節點還在 1.33": {
        "apiserver": ["1.37", "1.37", "1.37"], "controller-manager": ["1.37"], "scheduler": ["1.37"],
        "kubelet": {"k8s-node-1": "1.37", "k8s-node-3": "1.33"},
    },
}
for title, state in states.items():
    problems = skew_problems(state)
    print(f"  {title}：{'在支援範圍內' if not problems else '；'.join(problems)}")
```

三個步驟的檢查只差在版本號，每一步都要演練、排維護時段、輪替所有節點。路徑上的 1.35 只剩三個多月的修補，不能停在那裡。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `Unable to connect to the server: … x509: certificate has expired or is not yet valid` | kubeadm 產生的元件憑證預設效期 1 年，到期了 | 檢查與更新的步驟見 [Kubernetes 節點維護與備份](#/skill/k8s-node-maintenance) |
| `no matches for kind "PodDisruptionBudget" in version "policy/v1beta1"` | 叢集已經不提供這個 apiVersion | 照遷移指南改成新版本，必要時調整欄位 |
| `kubectl apply` 成功，但伺服器送回 `Warning: … is deprecated in v1.23+, unavailable in v1.26+` | 這個 apiVersion 已被標成 deprecated，到訊息裡的版本就停止提供 | 升級到那個版本之前，把 manifest 改成訊息建議的 apiVersion |
| `apt` 找不到新版的 kubeadm 套件 | pkgs.k8s.io 每個次版本一個套件庫，來源還指向舊的 | 改套件來源的版本；斷網環境先同步院內鏡像 |
| API server 一直重啟，`kubectl delete pod` 重啟不了它 | kubeadm 的控制平面元件是靜態 Pod，由 kubelet 直接管理 | 登入控制平面節點，用 `journalctl -u kubelet` 與 `crictl logs` 查 |
| 節點上找不到 `docker` 指令 | 1.24 起移除了 dockershim，容器執行環境是 containerd 或 CRI-O | 排查容器改用 `crictl` |

## 動手

1. 執行升級規劃器，把 `today` 改成 `date(2027, 3, 1)`：1.35 也已經停止修補。再把 `plan` 的目前版本改成 `"1.36"`，看要升幾次。
2. 做本課的程式題：從 manifest 找出目標版本已經不提供的 apiVersion。
3. 本機叢集若是 kind（內部用 kubeadm 建叢集），用 `docker exec` 進控制平面的容器，執行 `crictl ps`，對照「維運要顧的元件」那張表找出控制平面的靜態 Pod。
4. 替自己的叢集寫一份年度維運日曆：停止修補日、升級月份、憑證與 CA 到期日、還原演練日、作業系統修補時段。

節點維護（cordon、drain 與 PDB）、備份與還原、憑證更新、叢集本身的監控，接著讀 [Kubernetes 節點維護與備份](#/skill/k8s-node-maintenance)。
