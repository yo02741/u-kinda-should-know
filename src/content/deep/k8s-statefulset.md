## 三個節點的訊息佇列寫成 Deployment，名字與資料都對不上

這一課接在 [Kubernetes 儲存：PV、PVC 與 StorageClass](#/skill/k8s-storage) 之後。

院內訊息佇列 `clinic-queue`（示意用的程式）跑三個節點，每個節點保存自己那一份資料，啟動時要知道另外兩個節點的位址。寫成 Deployment 時，Pod 名稱是隨機的、重建後名字與 IP 都換掉，三個副本也只能共用同一個 PVC。

## StatefulSet：固定的名字、各自的 volume

```yaml
apiVersion: v1
kind: Service
metadata:
  name: clinic-queue-headless
  namespace: clinic
spec:
  clusterIP: None                      # headless：不分配虛擬 IP，DNS 直接回 Pod 的 IP
  selector:
    app: clinic-queue
  ports:
    - name: peer
      port: 7000
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: clinic-queue
  namespace: clinic
spec:
  serviceName: clinic-queue-headless   # 用這個 headless Service 產生每個 Pod 的 DNS 名稱
  replicas: 3
  selector:
    matchLabels:
      app: clinic-queue
  template:
    metadata:
      labels:
        app: clinic-queue
    spec:
      containers:
        - name: queue
          image: registry.gitlab.example/clinic/queue:2b7e9d41
          env:
            - name: NODE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name     # clinic-queue-0、-1、-2
            - name: PEERS
              value: clinic-queue-0.clinic-queue-headless:7000,clinic-queue-1.clinic-queue-headless:7000,clinic-queue-2.clinic-queue-headless:7000
          ports:
            - name: peer
              containerPort: 7000
          volumeMounts:
            - name: data
              mountPath: /var/lib/queue
  volumeClaimTemplates:                # 每個 Pod 依這個範本各建一個 PVC
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: longhorn
        resources:
          requests:
            storage: 10Gi
```

```bash
$ kubectl get pods,pvc -n clinic       # 只列出相關的、部分欄位省略
NAME                 READY   STATUS    AGE
pod/clinic-queue-0   1/1     Running   5m
pod/clinic-queue-1   1/1     Running   4m
pod/clinic-queue-2   1/1     Running   4m

NAME                                        STATUS   VOLUME           CAPACITY   ACCESS MODES   STORAGECLASS
persistentvolumeclaim/data-clinic-queue-0   Bound    pvc-8b20d4c1-…   10Gi       RWO            longhorn
persistentvolumeclaim/data-clinic-queue-1   Bound    pvc-c47e0b92-…   10Gi       RWO            longhorn
persistentvolumeclaim/data-clinic-queue-2   Bound    pvc-19ad5f3e-…   10Gi       RWO            longhorn
```

| StatefulSet 給的 | 怎麼做到 | 例子 |
|---|---|---|
| 固定的名稱 | Pod 名稱是 `<StatefulSet 名稱>-<序號>`，重建後同名 | 刪掉 `clinic-queue-1`，新的還叫 `clinic-queue-1` |
| 固定的 DNS | headless Service 替每個 Pod 建一筆 `<Pod>.<Service>.<namespace>.svc.cluster.local` | IP 會變，`clinic-queue-1.clinic-queue-headless.clinic.svc.cluster.local` 不變 |
| 各自的 volume | 每個序號一個 `<範本名稱>-<Pod 名稱>` 的 PVC，重建的 Pod 掛回同一個 | `clinic-queue-1` 一直掛 `data-clinic-queue-1` |

headless Service 要自己建，名稱和 `serviceName` 相同（DNS 的行為見 [Kubernetes 網路](#/skill/k8s-networking)）。同一個 namespace 裡寫到 `clinic-queue-1.clinic-queue-headless` 就夠了。

## 和 Deployment 差在哪

| | Deployment | StatefulSet |
|---|---|---|
| Pod 名稱與 DNS | 隨機後綴，透過 Service 找到其中一個 | `<名稱>-0`、`-1`，每個 Pod 有自己的 DNS 名稱 |
| volume | 所有副本共用同一個 PVC，或不用 | 每個副本自己的 PVC |
| 啟動與縮減 | 同時進行 | 預設依序號啟動，縮減從最大的開始 |
| 更新 | maxSurge、maxUnavailable，可以先多開 | 從最大的序號往回一次一個；partition 分段 |
| 縮減副本 | Pod 刪掉就結束 | Pod 刪掉，PVC 預設保留 |
| 節點故障 | 在別的節點補新 Pod | 確認舊 Pod 不在了才重建 |
| 適合 | 無狀態的 API、前端、worker | 需要固定身分與各自資料的服務：有複寫的資料庫、訊息佇列、搜尋引擎 |

StatefulSet 只保證名字與 volume。三個 Pod 是三份各自的資料，怎麼組成叢集、怎麼複寫、誰是主節點，是程式（或 operator）的事。

最常見的兩個誤會：縮減副本或刪掉整個 StatefulSet 都不會刪 PVC，留下的 PVC 繼續占空間；修改 `volumeClaimTemplates` 會被拒絕，訊息是 `updates to statefulset spec for fields other than … are forbidden`。兩者的處理在停靠點之後。

:::stop 讀到這裡可以先停：會把需要固定名稱與各自資料的服務寫成 StatefulSet 加 headless Service，說得出它和 Deployment 差在哪。後面的順序與更新、節點故障、擴充容量，在維運 StatefulSet 時回來讀；CSI 選型、資料庫放不放進叢集與備份，在要挑地端儲存或跑資料庫時再讀。

## 順序、更新與縮減

- **啟動**：預設的 `podManagementPolicy: OrderedReady` 依序號 0、1、2 建立，前一個 Running 而且 Ready 才建下一個；縮減時從最大的序號開始刪。不需要順序的服務可以改成 `Parallel`。
- **更新**：預設的 `RollingUpdate` 從最大的序號往回一次換一個，新的 Pod Ready 才換下一個。`rollingUpdate.partition: 2` 只更新序號大於等於 2 的 Pod，可以先換一個觀察。
- **縮減副本不刪 PVC**：從 3 縮成 2，`clinic-queue-2` 被刪，`data-clinic-queue-2` 留著；擴回 3 時新的 `clinic-queue-2` 掛回原本的資料。刪掉整個 StatefulSet 也一樣。要自動刪就設定 `persistentVolumeClaimRetentionPolicy` 的 `whenScaled`、`whenDeleted`（預設都是 `Retain`；1.27 起預設啟用，1.32 GA）。留下的 PVC 繼續占空間，確定不要時手動刪。
- **volumeClaimTemplates 建立後不能改**：要加大容量就個別修改每個 PVC。較新的版本有放寬這個限制的提案，以官方文件為準。

## 節點突然斷線時

節點突然斷線時，StatefulSet 不會立刻在別的節點建同名的 Pod：舊的 Pod 可能還在寫，兩個 `clinic-queue-1` 同時寫同一份資料會毀掉它。Pod 會停在 `Terminating` 或 `Unknown`。確認那台節點已經關機後，加上 `node.kubernetes.io/out-of-service` taint（non-graceful node shutdown，1.28 起 GA），Kubernetes 才會刪掉上面的 Pod、detach volume，再到別的節點重建。不確定節點狀態時，不要用 `--force` 刪 Pod。

```bash
kubectl taint nodes node-2 node.kubernetes.io/out-of-service=nodeshutdown:NoExecute
```

## 擴充 PVC 的容量

StorageClass 有 `allowVolumeExpansion: true`、driver 也支援時，把 PVC 的 `spec.resources.requests.storage` 改大就會擴充（Kubernetes 1.24 起 GA）：

```bash
kubectl patch pvc data-clinic-queue-0 -n clinic -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
kubectl get pvc data-clinic-queue-0 -n clinic -w      # CAPACITY 變成 20Gi 才算完成
```

多數 CSI driver 可以在 Pod 執行中擴充，少數要重啟 Pod，以 driver 的文件為準。容量只能加、不能減；擴充失敗後改回較小值的做法，1.34 起 GA，更早的版本要管理者手動處理。

## CSI 與地端的儲存選項

CSI（Container Storage Interface）是容器平台與儲存系統之間的標準介面，Kubernetes 1.13 起 GA。儲存廠商或開源專案寫一個 CSI driver，Kubernetes 就能建立、attach、掛載、擴充與快照它的 volume。早期內建在 Kubernetes 裡的雲端磁碟外掛，大多已經遷移到對應的 CSI driver。

一個 driver 在叢集裡通常分兩部分：controller（呼叫儲存系統的管理介面建立、attach、擴充、快照 volume）與 node（DaemonSet，每個節點一個，負責把 volume 掛到節點上）。

```bash
$ kubectl get csidrivers               # 只留前兩欄
NAME                 ATTACHREQUIRED
driver.longhorn.io   true
nfs.csi.k8s.io       false

$ kubectl get storageclass
NAME                 PROVISIONER          RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION   AGE
longhorn (default)   driver.longhorn.io   Retain          WaitForFirstConsumer   true                   90d
nfs-csi              nfs.csi.k8s.io       Retain          Immediate              false                  90d
```

`ATTACHREQUIRED` 是 `true` 的 driver，RWO 才會有 Multi-Attach 的限制。

| 選項 | 提供什麼 | 存取模式 | 適合 | 要注意 |
|---|---|---|---|---|
| NFS（接既有的 NAS） | 檔案 | RWO、ROX、RWX | 多個 Pod 共用的檔案：報表、上傳檔 | NAS 是單點，除非設備有 HA；延遲與檔案鎖不適合資料庫；權限靠 UID 對應 |
| Longhorn | 用節點的本機磁碟組成分散式區塊儲存，每個 volume 在幾個節點各放一份副本 | RWO；RWX 透過內建的 NFS | 中小型叢集；要快照與備份到叢集外的功能，又沒有專職的儲存人力 | 占用節點的磁碟、CPU 與網路；實際用量是容量乘上副本數 |
| Rook-Ceph | 用 operator 在叢集裡跑 Ceph：區塊（RBD）、檔案（CephFS）、物件（S3 相容） | RBD：RWO；CephFS：RWX | 規模較大，三種儲存都要 | 最複雜；要專用磁碟、足夠的節點與網路，出問題要懂 Ceph |
| 儲存設備廠商的 CSI driver | 既有的 SAN、NAS 直接提供 volume | 區塊：RWO；NAS：RWX | 已經有企業級儲存與維護合約 | 確認 driver 支援的 Kubernetes 版本、發行版、快照與擴充；權限與容量要和儲存組協調 |
| local PV | 節點本機的磁碟 | RWO | 自己會在節點之間複寫、要低延遲的服務（有複寫的資料庫、搜尋引擎） | 綁死在那個節點，節點壞了資料就拿不到；靜態佈建，搭配 WaitForFirstConsumer |

一個叢集常同時有兩三個 StorageClass，例如預設的區塊儲存給 RWO、NFS 給 RWX。選型先問儲存組手上有什麼設備、廠商有沒有 CSI driver：能接既有設備，通常比在節點上自建分散式儲存省維運人力。driver 有支援的 Kubernetes 版本範圍，叢集升級前要先查相容表（見 [Kubernetes 叢集維運](#/skill/k8s-operations)）。效能數字只信自己量的：上線前在目標 StorageClass 上用 fio 或應用程式自己的壓測工具量一次。

雲端代管的叢集預設就有對應雲端磁碟的 StorageClass（RWO），RWX 要另外接雲端的檔案服務；雲端磁碟通常只能掛在同一個可用區的節點，所以雲端也常用 `WaitForFirstConsumer`。

## 資料庫要不要放進叢集：放進去之前要做到的事

[導入 Kubernetes 前要準備什麼](#/skill/k8s-readiness) 的「資料庫要不要放進叢集」那一段，建議導入初期把資料庫留在既有的主機；門診掛號系統的 PostgreSQL 與院內舊系統的 Informix 都還在 VM 上。哪天要評估放進叢集，下面幾件事要先做到：

1. **用 operator，不要自己用 StatefulSet 組主從**。operator 是跑在叢集裡的控制器，把建立複寫、故障切換、切換後讓應用程式連到新的主節點、排程備份寫成程式。PostgreSQL 的 CloudNativePG 用一個 `Cluster` 物件描述節點數與備份目的地，由它建立 Pod、PVC 與 Service（它不用 StatefulSet，直接管 Pod 與 PVC）。團隊仍要懂 PostgreSQL 本身的複寫與升級，出事時才看得懂 operator 在做什麼。
2. **備份送到叢集外**：base backup 加上持續封存的 WAL，才能還原到指定時間點。PVC 的快照取代不了它。
3. **還原演練**：定期還原到另一個 namespace 或測試叢集，跑檢查用的查詢，記錄花了多久、資料落後多少（見 [健康檢查、備份與事故處理](#/skill/reliability)）。
4. **量儲存效能**：每次 commit 都要等資料寫進磁碟，分散式儲存的寫入還要經過網路送到其他節點的副本。上線前在目標 StorageClass 上用 fio 與 pgbench 量，和現在的 VM 比較。
5. **決定複寫做在哪一層**：三個資料庫節點各放在三副本的 Longhorn volume 上，一份資料會有九份。常見的做法是資料庫自己做串流複寫、volume 用 local PV 或單副本，並寫清楚故障時由誰切換。
6. **排程與容量**：requests 等於 limits、用 anti-affinity 分散到不同的實體主機、設 PodDisruptionBudget；用 kubelet 的 `kubelet_volume_stats_available_bytes` 等指標對 PVC 剩餘空間發告警（見 [可觀測性](#/skill/observability)）。

## 備份：有快照不等於有備份

VolumeSnapshot（`snapshot.storage.k8s.io/v1`，1.20 起 GA）的三個物件對應 PVC、PV、StorageClass：VolumeSnapshot（namespace 裡的申請）、VolumeSnapshotContent（實際的快照）、VolumeSnapshotClass（用哪個 driver、刪除時怎麼處理）。前提是 CSI driver 支援快照，而且叢集裝了快照的 CRD 與 snapshot controller；它們不屬於 Kubernetes 核心，很多發行版要另外裝。內建的 NFS volume、hostPath 不是 CSI，拍不了。

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: longhorn-snap
driver: driver.longhorn.io
deletionPolicy: Retain               # 刪 VolumeSnapshot 時保留實際的快照
# parameters 依 driver 而定，有些 driver 可以選擇把快照送到叢集外的備份目標
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: data-clinic-queue-0-20261119
  namespace: clinic
spec:
  volumeSnapshotClassName: longhorn-snap
  source:
    persistentVolumeClaimName: data-clinic-queue-0
---
apiVersion: v1                       # 從快照還原：建一個新的 PVC，dataSource 指向快照
kind: PersistentVolumeClaim
metadata:
  name: data-clinic-queue-0-restore
  namespace: clinic
spec:
  storageClassName: longhorn
  dataSource:
    name: data-clinic-queue-0-20261119
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 10Gi                  # 不能小於快照的大小
```

| | 儲存系統的快照 | 備份 |
|---|---|---|
| 放在哪 | 通常和原本的 volume 在同一個儲存系統 | 另一個系統，最好在另一個地點 |
| 儲存系統故障、被誤刪 | 一起不見；有些儲存系統刪 volume 時連快照一起刪 | 還在 |
| 一致性 | 某一瞬間的磁碟狀態，相當於突然斷電 | 資料庫工具做的備份是一致的，還能還原到指定時間點 |
| 適合 | 升級或 migration 前的回退點 | 災難復原、誤刪資料、法規要求的保存期限 |

刪掉 namespace 也會刪掉裡面的 VolumeSnapshot；`deletionPolicy` 是 `Delete` 時，實際的快照跟著消失。

Velero 是叢集層級的備份工具：把 Kubernetes 物件與 PV 的資料（透過 CSI 快照，或在節點上逐檔複製）備份到物件儲存，可以把整個 namespace 還原到另一個叢集。它的排程、etcd 快照與還原演練在 [Kubernetes 節點維護與備份](#/skill/k8s-node-maintenance)。不管用哪一種工具，條件都一樣：資料放在另一個系統、資料庫用資料庫自己的工具備份、定期還原演練、備份失敗時有人收到告警。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本與 driver 而異，下面是類似的樣子，出現在 `kubectl describe pvc` 或 `kubectl describe pod` 的 Events：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 擴充被拒：`only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize` | 靜態 PV，或 StorageClass 沒有 `allowVolumeExpansion: true` | 管理者確認 driver 支援後，在 StorageClass 加上這個欄位 |
| 修改 StatefulSet 被拒：`updates to statefulset spec for fields other than … are forbidden` | 改了 volumeClaimTemplates、selector 或 serviceName | 個別擴充 PVC；一定要改範本時，用 `kubectl delete statefulset --cascade=orphan` 保留 Pod 與 PVC 後重建 |
| 套用 VolumeSnapshot 失敗，或建立後一直沒有可用的快照 | CSI driver 不支援快照、叢集沒裝快照的 CRD 與 snapshot controller，或 volume 不是 CSI（內建的 NFS volume、hostPath） | 先確認 driver 支援快照，再確認發行版有沒有裝 CRD 與 snapshot controller |

## 動手

1. 做本課的程式題 `k8s-storage-2`：把一個需要固定名稱與各自資料的服務改成 StatefulSet 加 headless Service。
2. 在本機叢集練習（建立方式見 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）：
   - 套用本課的 `clinic-queue`：image 換成 `busybox:1.36`、`command` 改成 `["sh", "-c", "hostname >> /var/lib/queue/boot.log && sleep 3600"]`，刪掉 `storageClassName` 那一行改用預設的 class。縮到 1 個副本，確認三個 PVC 都還在；擴回 3 後執行 `kubectl exec clinic-queue-2 -n clinic -- cat /var/lib/queue/boot.log`，應該有兩行。再縮到 2、刪掉 `data-clinic-queue-2`，用 `kubectl get pv` 看 reclaimPolicy 的效果。
3. 對照「資料庫要不要放進叢集」的六件事，逐項寫下團隊的資料庫現在做到哪幾項、缺的那幾項由誰負責。
4. etcd 與整個叢集的備份、CSI driver 的升級，接著讀 [Kubernetes 節點維護與備份](#/skill/k8s-node-maintenance) 與 [Kubernetes 叢集維運](#/skill/k8s-operations)。
