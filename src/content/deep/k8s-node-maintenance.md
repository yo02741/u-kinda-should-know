## 修補一台節點的作業系統，drain 跑了十分鐘還沒結束

院內叢集排了維護時段，要修補 `k8s-node-2` 的作業系統。值班的工程師執行 drain，同一行錯誤每 5 秒重複一次：

```text
$ kubectl drain k8s-node-2 --ignore-daemonsets --delete-emptydir-data
error when evicting pods/"report-worker-7f6d4c8b9-p0c3a" -n "clinic" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
```

`report-worker` 只有 1 個副本，它的 PodDisruptionBudget 要求至少 1 個可用，等多久都一樣。這一課接在 [Kubernetes 叢集維運](#/skill/k8s-operations) 之後：升級時每台節點都要 drain 一次，卡在哪裡要在維護時段之前查出來。

## 節點維護：cordon、drain 與 PDB

作業系統修補、核心更新、kubelet 升級、換硬體，都是同一套流程：

```bash
kubectl cordon k8s-node-2      # 標成不可排程：上面的 Pod 不動，新的 Pod 不會排進來
kubectl drain k8s-node-2 --ignore-daemonsets --delete-emptydir-data   # 先 cordon，再把 Pod 驅逐
# ……修補、重開機、確認節點回到 Ready……
kubectl uncordon k8s-node-2    # 恢復可排程
```

| 參數 | 意思 | 不加會怎樣 |
|---|---|---|
| `--ignore-daemonsets` | DaemonSet 的 Pod（log 收集、CNI、kube-proxy）留在節點上 | drain 拒絕執行。DaemonSet 控制器不理會 cordon，驅逐了也會馬上補回同一台 |
| `--delete-emptydir-data` | 允許驅逐用了 `emptyDir` 的 Pod，`emptyDir` 的內容跟著刪除 | drain 拒絕執行，列出這些 Pod |
| `--force` | 允許刪除沒有控制器的 Pod（直接建立、不屬於任何 Deployment 等） | drain 拒絕執行；這種 Pod 刪掉後沒有人會重建 |
| `--timeout` | 最多等多久 | 預設 0，一直等 |

drain 透過 Eviction API 驅逐 Pod，會遵守 Pod 的優雅關機（`terminationGracePeriodSeconds`、`preStop`）與 **PodDisruptionBudget（PDB）**，寫法見 [設定、探針與資源](#/skill/k8s-config-probes)。實作路線的 `clinic-api` 有兩個副本，PDB 是 `minAvailable: 1`。

兩個副本剛好都在 `k8s-node-2` 時，drain 的輸出類似：

```text
node/k8s-node-2 cordoned
Warning: ignoring DaemonSet-managed Pods: kube-system/kube-proxy-q8z4t, logging/fluent-bit-m2v9c
evicting pod clinic/clinic-api-6c8f9d7b5-x7k2p
evicting pod clinic/clinic-api-6c8f9d7b5-p4m8n
error when evicting pods/"clinic-api-6c8f9d7b5-p4m8n" -n "clinic" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
pod/clinic-api-6c8f9d7b5-x7k2p evicted
evicting pod clinic/clinic-api-6c8f9d7b5-p4m8n
pod/clinic-api-6c8f9d7b5-p4m8n evicted
node/k8s-node-2 drained
```

第一個 Pod 被驅逐後只剩一個可用，PDB 允許的中斷變成 0，第二個收到 429、每 5 秒重試，等替代的 Pod 在別的節點 Ready 才被驅逐。drain 會永遠等下去的情況：

- 單一副本加上 `minAvailable: 1`，或 `minAvailable` 等於副本數、`maxUnavailable: 0`：全部健康時允許的中斷也是 0。
- 替代的 Pod 排不上：其他節點放不下，或 affinity、taint 不符。drain 一台節點，其他節點要扛它的 Pod，容量照 N+1 估，見 [硬體資源與容量規劃](#/skill/capacity-planning)。
- Pod 本來就不健康，已經吃掉了預算。較新的版本可以在 PDB 設 `unhealthyPodEvictionPolicy: AlwaysAllow`（以官方文件為準）。

`kubectl get pdb -A` 的 `ALLOWED DISRUPTIONS` 是 0 的，就是下一次 drain 會卡住的地方。`--disable-eviction` 改用直接刪除、不檢查 PDB，只能當最後手段。

修補一次一台：前一台回到 Ready、上面的 Pod 都恢復後才做下一台。控制平面節點每做完一台先確認 etcd 健康（`etcdctl endpoint health`），三個成員的 etcd 只容忍一個不在。

:::stop 讀到這裡可以先停：會用 cordon、drain、uncordon 清空並恢復一台節點，從 `kubectl get pdb` 的 `ALLOWED DISRUPTIONS` 看出下一次 drain 會卡在哪裡。後面的節點故障與 drain 模擬，在排節點維護前回來讀；備份與還原、憑證、監控，在排還原演練或叢集快滿一年時再讀。

## 節點故障時，Pod 多久會被重排

節點斷電或斷網時沒有人 drain 它：

1. kubelet 停止回報，過一段寬限時間，節點被標成 `NotReady` 並加上 `node.kubernetes.io/unreachable` taint，上面的 Pod 從 Service 的後端移出。
2. Pod 預設容忍這個 taint 300 秒（DefaultTolerationSeconds 這個 admission plugin 加上的），時間到才被驅逐，Deployment 在別的節點建立新的 Pod。

所以通常要幾分鐘才會在別處重建，確切時間依參數、Pod 的 toleration 與版本而定。StatefulSet 的 Pod 不會自動重建，因為無法確認舊的已經停止；確認節點真的關機後，可以手動加 `node.kubernetes.io/out-of-service` taint（1.28 起正式提供），見 [Kubernetes 有狀態服務](#/skill/k8s-statefulset)。

## 模擬一次 drain

下面把節點上的 Pod 與 PDB 寫成資料，模擬 drain 什麼時候完成、卡在哪裡：

```python run
# 簡化的 drain：每 5 秒一輪，對節點上還沒走的 Pod 發 eviction；PDB 不允許就收到 429，下一輪重試
STARTUP = 20   # 替代的 Pod 從建立到 Ready 的秒數（示意）


def cluster(report_replicas=1, free_mem=None):
    def pod(name, app, node, owner="Deployment", emptydir=False, mem=256):
        return {"name": name, "app": app, "node": node, "owner": owner,
                "emptydir": emptydir, "mem": mem, "ready": True}
    pods = [
        pod("clinic-api-6c8f9-x7k2p", "clinic-api", "k8s-node-2", mem=512),
        pod("clinic-api-6c8f9-p4m8n", "clinic-api", "k8s-node-2", mem=512),   # 兩個副本剛好都在這台
        pod("clinic-web-5d7c8-r2t5w", "clinic-web", "k8s-node-2", emptydir=True, mem=128),
        pod("clinic-web-5d7c8-h9q3z", "clinic-web", "k8s-node-1", emptydir=True, mem=128),
        pod("fluent-bit-m2v9c", "fluent-bit", "k8s-node-2", owner="DaemonSet", mem=64),
        pod("report-worker-7f6d4-p0c3a", "report-worker", "k8s-node-2", mem=1024),
    ]
    if report_replicas == 2:
        pods.append(pod("report-worker-7f6d4-k8w1d", "report-worker", "k8s-node-3", mem=1024))
    pdbs = {   # PDB 名稱 → 選到哪個 app、那個 Deployment 的副本數、minAvailable
        "clinic-api": {"app": "clinic-api", "replicas": 2, "min_available": 1},
        "report-worker": {"app": "report-worker", "replicas": report_replicas, "min_available": 1},
    }
    free = dict(free_mem or {"k8s-node-1": 2048, "k8s-node-3": 2048})   # 其他節點還能保留的記憶體（Mi）
    return pods, pdbs, free


def drain(node, pods, pdbs, free, ignore_daemonsets=False, delete_emptydir_data=False, timeout=120):
    mine = [p for p in pods if p["node"] == node]
    ds = [p["name"] for p in mine if p["owner"] == "DaemonSet"]
    local = [p["name"] for p in mine if p["emptydir"]]
    errors = []
    if ds and not ignore_daemonsets:
        errors.append("cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): " + ", ".join(ds))
    if local and not delete_emptydir_data:
        errors.append("cannot delete Pods with local storage (use --delete-emptydir-data to override): " + ", ".join(local))
    if errors:
        print("  node 已 cordon，但 drain 沒有開始驅逐：")
        for e in errors:
            print("    " + e)
        return
    print(f"  t=  0s  node/{node} cordoned；DaemonSet 的 Pod 留在節點上：{', '.join(ds) or '無'}")
    queue = [p for p in mine if p["owner"] != "DaemonSet"]
    told = set()
    for t in range(0, timeout + 1, 5):
        for p in pods:                                    # 替代的 Pod 時間到就 Ready
            if not p["ready"] and p.get("ready_at") is not None and t >= p["ready_at"]:
                p["ready"] = True
        for p in list(queue):
            name, pdb = next(((n, b) for n, b in pdbs.items() if b["app"] == p["app"]), (None, None))
            if pdb:
                healthy = sum(1 for q in pods if q["app"] == p["app"] and q["ready"])
                if healthy - pdb["min_available"] <= 0:
                    if p["name"] not in told:
                        print(f"  t={t:>3}s  429  {p['name']}：PDB {name} 允許的中斷是 0"
                              f"（可用 {healthy}，minAvailable {pdb['min_available']}），每 5 秒重試")
                        told.add(p["name"])
                    continue
            queue.remove(p)
            pods.remove(p)
            # 控制器補一個新的 Pod：找一個沒被 cordon、記憶體放得下的節點
            target = next((n for n, m in free.items() if m >= p["mem"]), None)
            new = dict(p, name=p["app"] + "-（新）", node=target, ready=False,
                       ready_at=t + STARTUP if target else None)
            pods.append(new)
            if target:
                free[target] -= p["mem"]
                print(f"  t={t:>3}s  evicted {p['name']} → 新的 Pod 排到 {target}，約 {STARTUP} 秒後 Ready")
            else:
                print(f"  t={t:>3}s  evicted {p['name']} → 新的 Pod 排不上任何節點，停在 Pending")
        if not queue:
            print(f"  t={t:>3}s  node/{node} drained")
            return
    for p in queue:
        name, pdb = next(((n, b) for n, b in pdbs.items() if b["app"] == p["app"]))
        if pdb["replicas"] - pdb["min_available"] <= 0:
            why = f"副本只有 {pdb['replicas']} 個、minAvailable {pdb['min_available']}，允許的中斷永遠是 0"
        else:
            why = "替代的 Pod 還沒 Ready（排不上節點，或啟動失敗）"
        print(f"  t={timeout}s  還在等：{p['name']}，卡在 PDB {name}：{why}")


print("A. kubectl drain k8s-node-2")
drain("k8s-node-2", *cluster())

print("\nB. 加上 --ignore-daemonsets --delete-emptydir-data")
drain("k8s-node-2", *cluster(), ignore_daemonsets=True, delete_emptydir_data=True)

print("\nC. report-worker 改成 2 個副本，另一個在 k8s-node-3")
drain("k8s-node-2", *cluster(report_replicas=2), ignore_daemonsets=True, delete_emptydir_data=True)

print("\nD. 同 C，但其他節點的記憶體只剩 400Mi")
drain("k8s-node-2", *cluster(report_replicas=2, free_mem={"k8s-node-1": 400, "k8s-node-3": 400}),
      ignore_daemonsets=True, delete_emptydir_data=True)
```

B 卡住的是單一副本的 `report-worker`，`clinic-api` 只多等了 20 秒。D 的 `report-worker` 被驅逐了：當下另一個副本健康，PDB 允許，但替代的 Pod 排不上，服務剩一個副本。PDB 只看驅逐那一刻的可用數，容量要另外算。

## 備份與還原

三種備份各管一部分：

| 方式 | 能還原 | 還原不了 |
|---|---|---|
| etcd 快照（RKE2 預設每 12 小時一次） | 整座叢集在某個時間點的所有物件，包含 Secret | PV 裡的資料、叢集外的資料庫 |
| Velero | 依 namespace 或 label 備份的物件與 volume，可以還原到另一座叢集 | 叢集外的資料庫 |
| GitOps（Argo CD、Flux 從 Git 重建） | Deployment、Service、ConfigMap 這類定義 | Secret（刻意不進 Git）、PV 裡的資料、手動建立的物件 |

實作路線的 PostgreSQL 留在叢集外，備份見 [資料庫維運](#/skill/db-operations)；GitOps 見 [Helm、Kustomize 與 GitOps](#/skill/k8s-helm-gitops)。

### etcd 快照

kubeadm 的 etcd 跑在靜態 Pod 裡，主機上不一定有 `etcdctl`，要另外裝與 etcd 版本相符的。在一台控制平面上做：

```bash
sudo etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /var/backups/etcd/etcd-$(date +%Y%m%d-%H%M).db

# 檢查快照檔：etcd 3.5 起，離線操作改用 etcdutl
sudo etcdutl snapshot status /var/backups/etcd/etcd-20261116-0200.db -w table
```

快照檔裡有叢集所有的 Secret，沒開 etcd 靜態加密時是明文（見 [秘密管理](#/skill/secrets)），要加密、限制存取，並複製到叢集以外的地方。

還原的步驟以官方的 [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/) 為準，概念是：

1. 停掉所有 API server（kubeadm：把 `kube-apiserver.yaml` 移出 manifests 目錄）。
2. `etcdutl snapshot restore <快照檔> --data-dir <新的資料目錄>`（etcd 3.6 起 `etcdctl` 不再提供還原）。多個成員時，每個成員都從同一份快照還原。
3. etcd 改用新的資料目錄，啟動 etcd 與 API server，再重啟 scheduler、controller-manager 與 kubelet。

叢集會回到快照的時間點：之後建立的物件不見了，之後刪掉的回來了。用 GitOps 的叢集，還原後再從 Git 同步一次。

### Velero

Velero 透過 API 備份物件，volume 用儲存快照或檔案層級的備份，存到 S3 相容的物件儲存。適合只還原某個 namespace，或搬到另一座叢集：

```bash
velero schedule create clinic-daily --schedule="0 2 * * *" --include-namespaces clinic
velero backup get
velero restore create --from-backup clinic-daily-20261116020000
```

volume 能不能用快照，取決於 CSI driver 是否支援（見 [Kubernetes 有狀態服務](#/skill/k8s-statefulset)）。

### 演練才算數

備份成功不代表能還原。定期在測試叢集實際還原：用 etcd 快照重建控制平面、用 Velero 把 `clinic` namespace 還原到另一座叢集，記下每一步花多久，寫進 runbook。演練要回答的問題見 [健康檢查、備份與事故處理](#/skill/reliability)。

## 憑證到期：哪些還能動，怎麼更新

kubeadm 建的叢集滿一年那天，`kubectl` 會回 `x509: certificate has expired or is not yet valid`（見 [Kubernetes 叢集維運](#/skill/k8s-operations) 的開頭）。已經在跑的容器由各節點的 kubelet 照顧，流量照常進來，掛號不會中斷。但 controller-manager 與 scheduler 也拿同一批到期的憑證連 API server，叢集不能再變更：新版部署不上去，Pod 被刪除或節點故障時沒有新的補上。

kubeadm 產生的元件憑證包括 API server、etcd、元件之間的用戶端憑證，以及 `admin.conf` 裡給 `kubectl` 用的那一張。1 年與 10 年是 kubeadm 的預設值，kubeadm 1.31 起可以用設定檔的 `certificateValidityPeriod` 調整；其他發行版有自己的效期與輪替規則。

kubeadm 的憑證放在每台控制平面的 `/etc/kubernetes/pki/` 與幾個 kubeconfig 檔裡。到期那天早上的檢查結果：

```bash
$ sudo kubeadm certs check-expiration
CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED
admin.conf                 Nov 12, 2026 01:40 UTC   <invalid>       ca                      no
apiserver                  Nov 12, 2026 01:40 UTC   <invalid>       ca                      no
apiserver-etcd-client      Nov 12, 2026 01:40 UTC   <invalid>       etcd-ca                 no
apiserver-kubelet-client   Nov 12, 2026 01:40 UTC   <invalid>       ca                      no
controller-manager.conf    Nov 12, 2026 01:40 UTC   <invalid>       ca                      no
etcd-healthcheck-client    Nov 12, 2026 01:40 UTC   <invalid>       etcd-ca                 no
etcd-peer                  Nov 12, 2026 01:40 UTC   <invalid>       etcd-ca                 no
etcd-server                Nov 12, 2026 01:40 UTC   <invalid>       etcd-ca                 no
front-proxy-client         Nov 12, 2026 01:40 UTC   <invalid>       front-proxy-ca          no
scheduler.conf             Nov 12, 2026 01:40 UTC   <invalid>       ca                      no
super-admin.conf           Nov 12, 2026 01:40 UTC   <invalid>       ca                      no

CERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME   EXTERNALLY MANAGED
ca                      Nov 10, 2035 01:40 UTC   8y              no
etcd-ca                 Nov 10, 2035 01:40 UTC   8y              no
front-proxy-ca          Nov 10, 2035 01:40 UTC   8y              no
```

（欄位依版本略有不同，`super-admin.conf` 是 1.29 起才有。）每台控制平面一台一台更新：

```bash
sudo kubeadm certs renew all

# 控制平面元件不會自動重新載入所有憑證：把靜態 Pod 的 manifest 移出再移回，讓 kubelet 重建它們
sudo mkdir -p /etc/kubernetes/manifests-off
sudo mv /etc/kubernetes/manifests/*.yaml /etc/kubernetes/manifests-off/
sleep 20                                     # 等 kubelet 發現檔案不見、停掉容器
sudo mv /etc/kubernetes/manifests-off/*.yaml /etc/kubernetes/manifests/

# admin.conf 換了新憑證；自己目錄下的 kubeconfig 是舊副本，要重新複製
sudo cp /etc/kubernetes/admin.conf ~/.kube/config && sudo chown "$(id -u):$(id -g)" ~/.kube/config
```

`kubeadm certs renew` 不會更新 CA。CA 預設 10 年，換 CA 是另一件大工程，到期日寫進維運文件。

kubelet 的憑證另外處理：

- **用戶端憑證**（連 API server 用）：kubeadm 預設開啟自動輪替，kubelet 快到期時自己申請新的，所以 `check-expiration` 不列它。節點長期關機、錯過輪替時才會出問題。
- **服務端憑證**（`kubectl logs`、`exec` 會經過）：預設是 kubelet 自簽。設定 `serverTLSBootstrap: true` 可改由叢集 CA 簽發，但這類 CSR 不會自動核准，要有人或工具核准（`kubectl certificate approve`）。

到期日要放進監控：用 blackbox exporter 探測 API server 的 6443 port，取 `probe_ssl_earliest_cert_expiry`，剩 30 天告警（做法同 [HTTPS 憑證](#/skill/https-certificates)）；不對外的用戶端憑證，用排程工作在每台控制平面跑 `kubeadm certs check-expiration`，把剩餘天數寫成指標。照節奏升級會順便換新，但升級延後的那一年，告警還是要在。

## 叢集本身的監控與日誌

應用程式的監控見 [可觀測性：log、metrics、trace](#/skill/observability)；叢集本身常見的組合：

| 元件 | 做什麼 |
|---|---|
| metrics-server | 節點與 Pod 當下的 CPU、記憶體，給 HPA 與 `kubectl top` 用；不存歷史 |
| kube-prometheus-stack | 一個 Helm chart：Prometheus、Alertmanager、Grafana、node-exporter、kube-state-metrics，加上元件與節點的儀表板和告警規則 |
| Fluent Bit（DaemonSet） | 每個節點讀容器的 log 與 systemd journal（kubelet、containerd），送到集中儲存 |
| Loki 或 Elasticsearch | 存 log、提供查詢 |

Pod 被刪除時 log 跟著消失，Events 預設也只留一小時左右，所以 log 要收到叢集外。告警至少要有：

- **etcd**：沒有 leader、成員掉線、磁碟 fsync 延遲高、資料庫接近空間配額（超過配額後 etcd 只接受讀取與刪除）。
- **憑證** 30 天內到期。
- **節點 NotReady** 超過幾分鐘；同時好幾台，通常是網路或儲存的共同問題。
- **磁碟壓力**（DiskPressure）：kubelet 會開始清映像、驅逐 Pod。
- **API server** 的錯誤率與延遲。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 換完憑證後 `error: You must be logged in to the server (Unauthorized)` | 用的還是舊的 kubeconfig 副本，裡面的用戶端憑證過期了 | 重新複製 `admin.conf` |
| drain 一直印 `Cannot evict pod as it would violate the pod's disruption budget` | PDB 允許的中斷是 0：單一副本、`minAvailable` 等於副本數、替代的 Pod 起不來 | `kubectl get pdb -A` 看 `ALLOWED DISRUPTIONS`；加副本、改 PDB，或查替代的 Pod 為什麼 Pending |
| drain 拒絕執行：`cannot delete DaemonSet-managed Pods`、`cannot delete Pods with local storage` | 少了 `--ignore-daemonsets`、`--delete-emptydir-data` | 確認 `emptyDir` 的內容可以丟掉，再加參數 |
| 節點 NotReady，kubelet 的 log 說 `kubelet.conf` 裡的憑證過期 | 節點長期關機，錯過 kubelet 用戶端憑證的輪替 | 依 kubeadm 的排錯文件重新產生，或把節點移出叢集後重新加入 |
| kube-prometheus-stack 裝好後，controller-manager、scheduler、etcd 一直顯示 down | kubeadm 預設讓這些元件的指標只監聽本機位址 | 調整監聽位址（先評估安全性），或關掉對應的監控項目 |

## 動手

1. 執行 drain 模擬，把 `clinic-api` 的 PDB 改成 `"min_available": 2`，先預測 B 會卡在哪裡再執行；再把 D 的 `free_mem` 調大，看 drain 何時完成。
2. 做本課的程式題：判斷一次 drain 會不會被 PDB 擋住（含百分比的 `minAvailable`、`maxUnavailable`）。
3. 依 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 的「多個 worker 的叢集」一節，用 `k8s/kind-config-workers.yaml` 建一座有兩個以上 worker 的本機叢集，套用 kind overlay（PDB 在 `k8s/base/pdb.yaml`）。副本數改成 1 再 drain 它所在的 worker，看 drain 卡住與 `kubectl get pdb` 的輸出；改回 2 再 drain 一次，同時用迴圈打 Service，看有沒有失敗的請求。
4. 本機叢集若是 kind（內部用 kubeadm 建叢集），用 `docker exec` 進控制平面的容器，執行 `kubeadm certs check-expiration`，記下最早到期的那一張與它的日期。
5. 把還原演練日、作業系統修補時段、憑證與 CA 到期日填進 [Kubernetes 叢集維運](#/skill/k8s-operations) 那份年度維運日曆。
