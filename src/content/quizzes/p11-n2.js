// 題庫：P11 新課（n2 批）：k8s-storage、k8s-statefulset
export default [
  {
    skill: 'k8s-storage',
    questions: [
      {
        q: '兩個 Pod 掛同一個 ReadWriteOnce 的 PVC（後端是需要 attach 的區塊儲存），兩個 Pod 剛好被排到同一個節點。結果會是什麼？',
        options: [
          '第二個 Pod 停在 ContainerCreating，Events 出現 Multi-Attach error',
          '第二個 Pod 停在 Pending，排程器發現 PVC 已經被另一個 Pod 使用',
          '兩個 Pod 都能啟動並寫入，RWO 限制的是節點，同一個節點上的 Pod 可以共用',
          '兩個 Pod 都能啟動，但 Kubernetes 會把第二個 Pod 的掛載自動改成唯讀',
        ],
        answer: 2,
        explain: 'ReadWriteOnce 是「單一節點可讀寫」，volume attach 到那個節點之後，同節點上的多個 Pod 都能掛載與寫入。Multi-Attach error 發生在第二個 Pod 被排到另一個節點時。排程器擋下第二個 Pod 是 ReadWriteOncePod 的行為。Kubernetes 不會替你把掛載改成唯讀，存取模式在掛載之後也不負責防寫。',
      },
      {
        q: '下面的 StorageClass 動態建立了一個 PV 給 PVC `clinic-report-pdfs`。沒有 Pod 在用這個 PVC 時執行 `kubectl delete pvc clinic-report-pdfs -n clinic`，資料會怎樣？',
        code: 'apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: longhorn\n  annotations:\n    storageclass.kubernetes.io/is-default-class: "true"\nprovisioner: driver.longhorn.io\nvolumeBindingMode: WaitForFirstConsumer\nallowVolumeExpansion: true',
        lang: 'yaml',
        options: [
          'PV 變成 Released，資料保留；之後建立同名的 PVC 會自動綁回原本的 PV',
          'reclaimPolicy 沒寫就是 Delete：PV 與後端 volume 一起刪除',
          'reclaimPolicy 沒寫，預設是 Retain：PV 與資料保留，要管理者手動清除',
          'Kubernetes 會先替這個 volume 建一個 VolumeSnapshot，再刪除 PV',
        ],
        answer: 1,
        explain: '動態建立的 PV 繼承 StorageClass 的 reclaimPolicy，StorageClass 沒寫時是 Delete，刪 PVC 就連後端的 volume 一起刪。Retain 是手動建立的 PV 的預設值；就算是 Retain，Released 的 PV 也不會自動綁給新的 PVC，要管理者清掉 claimRef。Kubernetes 不會在刪除前自動拍快照。正式環境的 StorageClass 多半明確寫 reclaimPolicy: Retain。',
      },
      {
        q: 'PVC 建立後一直是 Pending，kubectl describe pvc 的 Events 是 waiting for first consumer to be created before binding。該怎麼處理？',
        options: [
          '不用處理：StorageClass 是 WaitForFirstConsumer，等用到它的 Pod 被排程後才綁定',
          'StorageClass 的名稱打錯了，刪掉 PVC 之後用正確的名稱重新建立',
          '叢集沒有預設的 StorageClass，要在 PVC 寫明 storageClassName',
          '儲存空間不夠，請管理者先手動建立一個容量夠大的 PV 再重試',
        ],
        answer: 0,
        explain: 'WaitForFirstConsumer 會等第一個用這個 PVC 的 Pod 被排程，選好節點後才建立或綁定 PV；等待期間 PVC 是 Pending，屬於正常狀態。地端的 local PV 與只接到部分節點的 SAN 要用這個模式，否則 PV 可能建在 Pod 去不了的地方。class 名稱打錯的訊息是 storageclass.storage.k8s.io "…" not found；沒有預設 class 的訊息是 no persistent volumes available for this claim and no storage class is set。',
      },
    ],
  },
  {
    skill: 'k8s-statefulset',
    questions: [
      {
        q: '下面的 StatefulSet 建立之後，序號最小的那個副本，Pod 名稱與 PVC 名稱各是什麼？',
        code: 'apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: clinic-queue\nspec:\n  serviceName: clinic-queue-headless\n  replicas: 3\n  volumeClaimTemplates:\n    - metadata:\n        name: data',
        lang: 'yaml',
        options: [
          'clinic-queue-1 與 data-clinic-queue-1',
          'clinic-queue-0 與 data-clinic-queue-0',
          'clinic-queue-0 與 clinic-queue-headless-data-0',
          'clinic-queue-0 與 data（三個副本共用同一個 PVC）',
        ],
        answer: 1,
        explain: 'Pod 名稱是 <StatefulSet 名稱>-<序號>，序號從 0 開始；每個序號有一個 <範本名稱>-<Pod 名稱> 的 PVC，重建的 Pod 掛回同一個。headless Service 的名稱用在每個 Pod 的 DNS 名稱（clinic-queue-0.clinic-queue-headless），不在 PVC 的名稱裡。所有副本共用同一個 PVC 是 Deployment 的做法。',
      },
      {
        q: '測試環境把 StatefulSet `clinic-queue` 從 3 個副本縮成 2 個，想省下儲存空間。幾天後發現 Longhorn 的用量完全沒有減少。原因與處理方式是什麼？',
        options: [
          'PV 進入 Released 狀態，要等 Kubernetes 的垃圾回收在下一個週期清掉，等著就好',
          '縮減時 StatefulSet 先刪最小序號的 Pod，clinic-queue-0 的資料被搬到其他 PVC，用量所以不變',
          'Longhorn 的副本要等節點重開機才會釋放，要排程輪流重啟節點',
          '縮減預設保留 PVC，data-clinic-queue-2 還在，要另外刪除',
        ],
        answer: 3,
        explain: 'StatefulSet 縮減時從最大的序號開始刪 Pod，但 volumeClaimTemplates 建出來的 PVC 預設保留（whenScaled 與 whenDeleted 都是 Retain），擴回 3 時新的 clinic-queue-2 才能掛回原本的資料。PVC 還在，PV 就還是 Bound，不會進入 Released，也沒有垃圾回收會處理它。縮減是從最大的序號開始，不會搬資料；空間不會因為重開機而釋放。',
      },
      {
        q: '儲存系統每小時替資料庫的 volume 拍一次快照，團隊因此認為備份已經有了。哪個說法正確？',
        options: [
          '快照是資料庫層級一致的，還能還原到任意時間點，比資料庫工具做的備份完整',
          'VolumeSnapshotClass 的 deletionPolicy 設成 Retain，快照就會複製到叢集外',
          '快照通常和原本的 volume 在同一個儲存系統，儲存系統故障時會一起不見',
          '快照是 Kubernetes 核心的功能，hostPath 與內建的 NFS volume 也都拍得了',
        ],
        answer: 2,
        explain: '快照通常和原本的 volume 在同一個儲存系統，儲存系統故障或 volume 被誤刪時一起不見；它是某一瞬間的磁碟狀態，相當於突然斷電，適合當升級或 migration 前的回退點。備份要放在另一個系統，資料庫用資料庫自己的工具備份，才能還原到指定時間點。deletionPolicy 只決定刪 VolumeSnapshot 時實際的快照留不留。快照要 CSI driver 支援，叢集還要另外裝 CRD 與 snapshot controller；內建的 NFS volume、hostPath 不是 CSI，拍不了。',
      },
    ],
  },
]
