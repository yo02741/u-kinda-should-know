// 領域內文（d9-devops，n2 批）：以技能 id 為 key，由 body/d9-devops.js 合併。只放這些技能：k8s-storage、k8s-statefulset
export default {
  'k8s-storage': {
    points: [
      { b: '資料跟著哪一種 volume 走', t: '容器自己的檔案系統在重建後就沒了；`emptyDir` 跟著 Pod，Pod 離開節點就刪除；configMap、secret 掛成唯讀檔案；`hostPath` 綁在某個節點又能讀寫節點上的任何路徑，Pod Security 的 baseline 就禁止它。要保留的資料用 PVC。' },
      { b: 'PVC 是申請，PV 是空間，StorageClass 決定怎麼建', t: 'PV controller 找 class 相同、存取模式涵蓋、容量夠的 PV（挑最小的），找不到就由 CSI driver 依 StorageClass 動態建立。`WaitForFirstConsumer` 等 Pod 排好節點才建，地端的 local PV 與只接部分節點的 SAN 要用它。動態建立的 PV 預設 reclaimPolicy 是 Delete：刪 PVC 就刪資料。' },
      { b: 'ReadWriteOnce 限制的是節點', t: 'RWO 是單一節點可讀寫，同節點的多個 Pod 可以一起用；需要 attach 的區塊儲存被另一個節點的 Pod 要求時，那個 Pod 停在 ContainerCreating（Multi-Attach error）。多個節點共用要 RWX（NFS、CephFS）；只准一個 Pod 用是 ReadWriteOncePod（1.29 GA，只支援 CSI）。Deployment 掛 RWO 只能 1 個副本並改用 Recreate。' },
      { b: 'Deployment 掛 RWO：1 個副本加 Recreate', t: '預設的 RollingUpdate 先開新 Pod 再關舊的，新 Pod 被排到別的節點就卡在 Multi-Attach，更新停住。要多副本有三條路：PVC 改成 RWX、改存物件儲存、維持單副本並接受更新時中斷。RWX 之下兩個 Pod 寫同一個檔名會互相覆蓋，檔名要帶日期與 Pod 名稱。' },
      { b: 'mountPath 寫錯沒有錯誤，PVC 寫錯要重建', t: '`volumeMounts` 的 name 對不到 `volumes` 時 API server 直接拒絕；`mountPath` 寫錯則程式照樣寫進容器自己的檔案系統，重建後才發現。PVC 建立後 `storageClassName` 與存取模式都不能改；還有 Pod 在用的 PVC 被刪除時會停在 Terminating。' },
    ],
    checklist: [
      '看到 PVC 停在 Pending，能從 Events 判斷是 StorageClass 名稱、沒有預設 class、存取模式還是 WaitForFirstConsumer，並說出刪 PVC 時 Delete 與 Retain 的差別',
      '能依副本數與是否共用資料，在 RWO、RWX、ReadWriteOncePod 與物件儲存之間做選擇，並說明 Deployment 掛 RWO 時遇到 Multi-Attach 的原因',
      '能說出容器的檔案系統、emptyDir、hostPath 與 PVC 的資料各在什麼時候消失，並檢查 mountPath 是不是程式實際寫入的路徑',
    ],
    challenge: {
      task: '先做 [修好報表服務的 PVC 與 Deployment](#/exercise/k8s-storage-1)。再照 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建 kind 叢集，用預設的 StorageClass 建一個 PVC 與單一副本的 Deployment，往 volume 寫一個帶時間戳的檔案，然後依序：刪 Pod、刪掉 Deployment 再重建、刪掉 PVC 再重建。每一步之後檢查檔案還在不在，並記下 `kubectl get pv` 的 STATUS 與 RECLAIM POLICY。',
      deliver: '三步各一列：操作、檔案在不在、PV 的 STATUS 與 RECLAIM POLICY',
      check: [
        '刪 Pod 與重建 Deployment 之後檔案都還在，並說明是因為 PVC 沒變',
        '刪 PVC 之後檔案消失，並從 `kubectl get pv` 或 StorageClass 看出 reclaimPolicy 是 Delete',
        '寫出要讓第三步保住資料的設定（`reclaimPolicy: Retain`），以及之後要手動處理的事',
        '說明這三步為什麼都不能取代備份',
      ],
      twist: '用指南的多個 worker 的叢集，把副本數改成 2。先預測第二個 Pod 會停在 ContainerCreating 並出現 Multi-Attach error、停在 Pending，還是和第一個排到同一個節點，再用 `kubectl get pods -o wide` 與 `describe` 驗證，說明 kind 的預設儲存和需要 attach 的區塊儲存差在哪裡。',
    },
    refs: [
      { label: 'Kubernetes：Volumes', url: 'https://kubernetes.io/docs/concepts/storage/volumes/' },
      { label: 'Kubernetes：Persistent Volumes', url: 'https://kubernetes.io/docs/concepts/storage/persistent-volumes/' },
      { label: 'Kubernetes：Storage Classes', url: 'https://kubernetes.io/docs/concepts/storage/storage-classes/' },
    ],
  },
  'k8s-statefulset': {
    map: {
      names: [
        { n: 'StatefulSet', t: '給每個副本固定的名稱（`<名稱>-0`、`-1`）與自己的 PVC；重建的 Pod 同名、掛回同一個 PVC。' },
        { n: 'headless Service', t: '`clusterIP: None` 的 Service，DNS 直接回 Pod 的 IP，讓每個 Pod 有自己的 DNS 名稱。' },
        { n: 'volumeClaimTemplates', t: 'StatefulSet 裡的 PVC 範本，每個序號依它建一個 `<範本名稱>-<Pod 名稱>` 的 PVC；建立後不能改。' },
        { n: 'CSI driver', t: '儲存系統接 Kubernetes 的標準介面；決定支援哪些存取模式、能不能擴充與快照。' },
        { n: 'operator', t: '跑在叢集裡的控制器，把資料庫的複寫、故障切換與備份排程寫成程式。' },
        { n: 'VolumeSnapshot', t: '對 PVC 拍快照的 API，要 CSI driver 支援並另外安裝 CRD 與 snapshot controller。' },
        { n: 'Velero', t: '叢集層級的備份工具，把 Kubernetes 物件與 PV 的資料備份到物件儲存。' },
      ],
      ask: [
        '服務需不需要固定的名稱、各自的資料，節點之間怎麼找到彼此。',
        '每個副本的 PVC 用哪個 StorageClass、多大、存取模式。',
        '複寫由誰做：程式自己、operator，還是儲存層。',
        '備份送到哪個叢集外的系統、多久還原演練一次。',
        '縮減副本或刪掉 StatefulSet 之後，留下的 PVC 由誰處理。',
      ],
      prompt: '把 3 個節點的訊息佇列 `clinic-queue` 寫成 StatefulSet：每個副本用 volumeClaimTemplates 各建一個 10Gi、ReadWriteOnce、class `longhorn` 的 PVC，掛在 `/var/lib/queue`；另外建一個同名於 `serviceName` 的 headless Service（port 7000）。環境變數 `PEERS` 列出三個 Pod 各自的 DNS 名稱 `clinic-queue-0.clinic-queue-headless:7000`，依此類推；`NODE_ID` 取自 Pod 名稱。所有物件在 `clinic` namespace。',
      verify: [
        { c: '名稱與 PVC', t: '`kubectl get pods,pvc -n clinic`：Pod 是 `clinic-queue-0` 到 `-2`，PVC 是 `data-clinic-queue-0` 到 `-2`，各自 Bound。' },
        { c: 'headless Service', t: 'Service 的 `clusterIP` 是 `None`，名稱等於 StatefulSet 的 `serviceName`。AI 產生的 manifest 常漏掉這個 Service，或 `PEERS` 只寫 Service 名稱。' },
        { c: '重建後掛回同一份資料', t: '刪掉 `clinic-queue-1`，新的 Pod 同名，volume 裡先前寫的檔案還在。' },
        { c: '縮減不刪 PVC', t: '縮成 2 個副本後 `data-clinic-queue-2` 還在；用量沒減少是正常行為。' },
        { c: '快照不是備份', t: '問備份放在哪個系統：和原本的 volume 在同一個儲存系統的只算快照。' },
      ],
    },
    points: [
      { b: 'StatefulSet：固定的名字與各自的 PVC', t: 'Pod 叫 `<名稱>-0`、`-1`，搭配 headless Service（`clusterIP: None`）各有自己的 DNS 名稱；`volumeClaimTemplates` 替每個副本建自己的 PVC，重建後掛回同一個。它只保證名字與 volume，不替程式做複寫。' },
      { b: '順序、更新與縮減', t: '預設依序號啟動、從最大的序號往回更新，`partition` 可以先換一個觀察。縮減副本或刪掉 StatefulSet 都不刪 PVC。節點突然斷線時不會立刻在別處建同名的 Pod，確認節點已關機後加上 out-of-service taint 才會重建。' },
      { b: '地端自己選儲存', t: 'CSI 是儲存系統接 Kubernetes 的標準介面。NFS 簡單、支援 RWX 但 NAS 是單點；Longhorn 用節點磁碟做分散式區塊儲存；Rook-Ceph 提供區塊、檔案、物件但最複雜；廠商的 CSI driver 接既有的 SAN、NAS；local PV 綁節點。效能數字只信自己在目標 StorageClass 上量的。' },
      { b: '資料庫放進叢集前要先做到的事', t: '用 operator，不要自己用 StatefulSet 組主從；備份送到叢集外（base backup 加持續封存的 WAL）；定期還原演練；量儲存效能；決定複寫做在資料庫還是儲存層；requests 等於 limits、anti-affinity、PodDisruptionBudget 與 PVC 剩餘空間的告警。' },
      { b: '有快照不等於有備份', t: 'VolumeSnapshot 要 driver 支援，叢集還要另外裝 CRD 與 snapshot controller。快照通常和原資料在同一個儲存系統，儲存系統故障或被誤刪時一起不見；它是某一瞬間的磁碟狀態，相當於突然斷電。備份放在另一個系統，資料庫用資料庫自己的工具備份。' },
    ],
    checklist: [
      '能把需要固定名稱與各自資料的服務寫成 StatefulSet 加 headless Service，並說明縮減副本、節點故障時 PVC 與 Pod 會怎樣',
      '能依手上的設備與人力，在 NFS、Longhorn、Rook-Ceph、廠商的 CSI driver 與 local PV 之間做選擇，並說出各自要注意的事',
      '能列出資料庫放進叢集前要做到的事，並說明快照和備份差在放在哪裡、一致性與適合的用途',
    ],
    challenge: {
      task: '先做 [把需要固定名稱與各自資料的服務改成 StatefulSet](#/exercise/k8s-storage-2)。再照 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建 kind 叢集，套用深入內容的 `clinic-queue`（image 換成 `busybox:1.36`，啟動時把 hostname 附加到 volume 裡的檔案）。依序：刪掉 `clinic-queue-1`、縮成 1 個副本、擴回 3 個副本。每一步之前先寫下預測：哪些 Pod 與 PVC 還在、`clinic-queue-2` 的檔案會有幾行。',
      deliver: '三步各一列：操作、預測、`kubectl get pods,pvc` 的實際結果與檔案內容',
      check: [
        '刪掉 `clinic-queue-1` 之後，新的 Pod 同名並掛回 `data-clinic-queue-1`，檔案多一行',
        '縮成 1 個副本後三個 PVC 都還在，並說明原因',
        '擴回 3 個副本後 `clinic-queue-2` 的檔案有兩行',
        '預測在執行前寫下，和結果並排',
      ],
      twist: '把這個服務換成正式環境的 PostgreSQL：三個資料庫節點各放在三副本的 Longhorn volume 上。先預測一份資料總共存了幾份、節點故障時誰負責切換，再寫出複寫要做在哪一層、備份送到哪裡。',
    },
    refs: [
      { label: 'Kubernetes：StatefulSets', url: 'https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/' },
      { label: 'Kubernetes：Volume Snapshots', url: 'https://kubernetes.io/docs/concepts/storage/volume-snapshots/' },
      { label: 'Kubernetes：Storage Classes', url: 'https://kubernetes.io/docs/concepts/storage/storage-classes/' },
    ],
  },
}
