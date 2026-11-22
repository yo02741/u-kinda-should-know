// 領域內文（d9-devops，n4 批）：以技能 id 為 key，由 body/d9-devops.js 合併。只放這些技能：k8s-operations、k8s-node-maintenance
export default {
  'k8s-operations': {
    map: {
      names: [
        { n: '次版本與修補版', t: '版本號是 `1.次版本.修補版`；上游大約每 4 個月出一個次版本，每版修補約 14 個月。' },
        { n: '版本差異政策', t: '升級途中各元件能差幾個次版本：kubelet 不能比 API server 新，最多舊 3 個。' },
        { n: 'kubeadm upgrade', t: '`plan` 檢查能不能升、列出新舊版本；`apply` 升第一台控制平面，其他節點用 `upgrade node`。' },
        { n: '被移除的 API', t: 'beta 版的 apiVersion 幾個版本後停止提供；會壞的是 Git 裡的 manifest、Helm chart 與 CI。' },
        { n: '發行版', t: 'kubeadm、RKE2、k3s、OpenShift 的差別在支援與修補、升級工具、預設安全設定與需要的人力。' },
        { n: '靜態 Pod', t: 'kubeadm 的控制平面元件由 kubelet 直接讀 `/etc/kubernetes/manifests/` 啟動，`kubectl delete pod` 重啟不了。' },
      ],
      ask: [
        '目前的次版本、目標的次版本，各自的停止修補日。',
        '控制平面與節點的升級順序，以及每一步之前要做的檢查。',
        'manifest、Helm release 與叢集收到的請求裡，有沒有目標版本不再提供的 apiVersion。',
        'CNI、Ingress controller、CSI driver、監控、Velero 支不支援目標版本。',
        '升壞了怎麼回復、維護時段多長。',
      ],
      prompt: '一座 kubeadm 建的叢集目前是 1.34，三台控制平面、三台 worker，要升到 1.37。排出升級路徑：每一步升到哪個次版本、先控制平面再節點的順序、每一步之前要做的檢查（release notes、被移除的 apiVersion、周邊元件的支援版本、etcd 快照、測試叢集演練）。另外列出升級途中哪些版本組合違反版本差異政策。',
      verify: [
        { c: '有沒有跳版', t: '控制平面一次只能升一個次版本；1.34 到 1.37 的計畫只有一步就是錯的，要依序升三次。' },
        { c: '順序', t: '計畫裡有節點比控制平面先升的步驟就是錯的：kubelet 不能比 API server 新。' },
        { c: '被移除的 API', t: '`kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis` 看誰還在用；套用時出現 `no matches for kind` 代表叢集已經不提供那個 apiVersion。' },
        { c: '停止修補日', t: '對照 kubernetes.io/releases；路徑上快停止修補的版本不能當終點。' },
      ],
    },
    points: [
      { b: '先分清楚要顧的元件', t: '控制平面是 API server、etcd、scheduler、controller-manager；節點上是 kubelet、容器執行環境與 kube-proxy。kubeadm 的控制平面是靜態 Pod（`/etc/kubernetes/manifests/`），API server 起不來時要上節點用 `crictl` 與 `journalctl -u kubelet` 查。1.24 起移除 dockershim，節點跑的是 containerd 或 CRI-O。' },
      { b: '發行版決定誰修補、誰負責升級', t: 'kubeadm 是上游工具，CNI、Ingress、儲存、監控、備份全部自己來；RKE2 與 k3s 內建較多元件與較嚴的預設，可向 SUSE 買支援；OpenShift 是 Red Hat 的平台，預設最嚴、自帶升級頻道；Rancher 是管理多座叢集的平台。比較的是支援與修補、升級工具、預設安全設定與需要的人力。' },
      { b: '每年都要升級，而且一次一個次版本', t: '上游大約每 4 個月出一個次版本、維護最近三個，每版修補約 14 個月（以 kubernetes.io/releases 為準）。控制平面一次只能升一個次版本；先控制平面再節點，kubelet 不能比 API server 新、最多舊 3 個次版本。' },
      { b: '升級前找出被移除的 API', t: '已經在叢集裡的物件不會消失；會壞的是 Git 裡的 manifest、Helm chart、CI 的 `kubectl apply` 與還在呼叫舊 API 的程式。查三個地方：`apiserver_requested_deprecated_apis` 指標、用掃描工具比對 manifest 與 chart、Helm release 裡存的舊 manifest。' },
      { b: '升級要演練，降版沒有官方支援', t: '`kubeadm upgrade` 預設會順便更新憑證。斷網環境先把新版的映像同步到院內 registry；周邊元件先確認支援的版本範圍。控制平面降版沒有一般性的官方支援，回復手段是升級前的 etcd 快照，所以先在測試叢集演練並走變更單。' },
    ],
    checklist: [
      '能替一座落後的叢集排出升級路徑：每一步的次版本、要檢查的 API 與附加元件、控制平面與節點的順序，並指出哪些版本組合違反版本差異政策',
      '能說出 kubeadm、RKE2、k3s、OpenShift 在支援與修補、升級工具、預設安全設定上的差別',
      '看到 `no matches for kind … in version …` 與 deprecated 的警告，能說出原因，並列出升級前要查的三個地方',
    ],
    challenge: {
      task: '替一座 1.34 的叢集寫升級到 1.37 的變更單。先執行課文的升級規劃器，把 `today` 改成你做題的日期（發行日與停止修補日以 kubernetes.io/releases 為準，註明查詢日期）。再做 [升級前找出已被移除的 apiVersion](#/exercise/k8s-operations-2)，把掃描的步驟寫進每一次升級之前。執行規劃器之前先寫下預測：要升幾次、路徑上哪個版本最先停止修補。',
      deliver: '一份變更單：升級路徑、每一步之前的檢查、維護時段、回復條件與步驟，加上事前的預測',
      check: [
        '路徑一次只升一個次版本，每一步都是先控制平面、再節點',
        '每一步之前都有掃描被移除的 apiVersion、確認周邊元件支援版本、etcd 快照三項',
        '回復的做法寫的是用升級前的 etcd 快照與舊版元件重建，不是降版',
        '預測在執行規劃器之前寫下，和輸出並排',
      ],
      twist: '維護時段只夠一個晚上升完控制平面，worker 要分三個晚上。先預測這段期間的版本組合有沒有違反版本差異政策，再用規劃器的 `skew_problems` 驗證。',
    },
    refs: [
      { label: 'Kubernetes：Releases', url: 'https://kubernetes.io/releases/' },
      { label: 'Kubernetes：Version Skew Policy', url: 'https://kubernetes.io/releases/version-skew-policy/' },
      { label: 'Kubernetes：Upgrading kubeadm clusters', url: 'https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/' },
      { label: 'Kubernetes：Deprecated API Migration Guide', url: 'https://kubernetes.io/docs/reference/using-api/deprecation-guide/' },
    ],
  },
  'k8s-node-maintenance': {
    map: {
      names: [
        { n: 'cordon 與 uncordon', t: '把節點標成不可排程、恢復可排程；上面的 Pod 不動。' },
        { n: 'drain', t: '先 cordon，再透過 Eviction API 驅逐 Pod；遵守優雅關機與 PodDisruptionBudget。' },
        { n: 'PodDisruptionBudget（PDB）', t: '`minAvailable` 或 `maxUnavailable`；允許的中斷是 0 時，drain 每 5 秒重試、一直等。' },
        { n: 'etcd 快照', t: '整座叢集在某個時間點的所有物件，包含 Secret；不含 PV 裡的資料。' },
        { n: 'Velero', t: '依 namespace 或 label 備份物件與 volume，可以還原到另一座叢集。' },
        { n: 'kubeadm certs', t: '`check-expiration` 看到期日，`renew all` 更新；元件憑證預設 1 年、CA 10 年。' },
      ],
      ask: [
        '要維護哪一台節點、上面有哪些 Pod、各自的副本數與 PDB。',
        '`emptyDir` 的內容能不能丟、有沒有不屬於任何控制器的 Pod。',
        '備份涵蓋什麼：叢集的物件、volume 的資料、叢集外的資料庫各由誰備份。',
        '還原演練多久做一次、完成條件是什麼。',
        '憑證與 CA 的到期日由誰看、剩幾天告警。',
      ],
      prompt: '院內叢集要修補 `k8s-node-2` 的作業系統。寫出維護步驟：cordon、`kubectl drain --ignore-daemonsets --delete-emptydir-data`、修補重開機、確認節點回到 Ready、uncordon，一次一台。drain 之前先用 `kubectl get pdb -A` 列出 `ALLOWED DISRUPTIONS` 是 0 的 PDB，並說明每一個要加副本、改 PDB，還是補排程容量。',
      verify: [
        { c: 'drain 會不會卡住', t: '`kubectl get pdb -A` 的 `ALLOWED DISRUPTIONS` 是 0 的，就是下一次 drain 會卡住的地方。' },
        { c: '參數', t: '少了 `--ignore-daemonsets` 或 `--delete-emptydir-data`，drain 拒絕執行並列出那些 Pod；`--force` 不會略過 PDB。' },
        { c: '還原有沒有演練過', t: '演練紀錄要有每一步的耗時與還原後查得到的資料；備份指令成功不算。' },
        { c: '快照有沒有保護', t: 'etcd 快照裡有所有的 Secret，要加密、限制存取，並複製到叢集以外的地方。' },
        { c: '憑證到期日', t: '`kubeadm certs check-expiration` 的 `RESIDUAL TIME`；更新之後要重建靜態 Pod、重新複製 `admin.conf`。' },
      ],
    },
    points: [
      { b: 'drain 走 eviction，會被 PDB 擋住', t: '`cordon` 只停止排程；`drain` 再加上驅逐，遵守優雅關機與 PodDisruptionBudget。`--ignore-daemonsets` 讓 DaemonSet 的 Pod 留著，`--delete-emptydir-data` 允許刪掉 emptyDir 的內容。單一副本加 `minAvailable: 1`、`minAvailable` 等於副本數、替代的 Pod 排不上，drain 都會一直重試。作業系統修補走同一套流程，一次一台。' },
      { b: '節點故障時要幾分鐘才重排', t: '節點斷電或斷網，過一段寬限時間被標成 NotReady，Pod 預設容忍 300 秒才被驅逐，Deployment 才在別的節點建立新的 Pod。StatefulSet 的 Pod 不會自動重建，確認節點真的關機後才手動處理。' },
      { b: '三種備份各管一部分', t: 'etcd 快照能還原整座叢集的物件（含 Secret，要保護），還原不了 PV 裡的資料；Velero 備份 namespace 與 volume，可以還原到另一座叢集；GitOps 能從 Git 重建資源定義，重建不了資料與 Secret。叢集外的資料庫要另外備份。' },
      { b: '備份要演練還原', t: '定期在測試叢集實際還原：用 etcd 快照重建控制平面、用 Velero 把 namespace 還原到另一座叢集，記下每一步花多久，寫進 runbook。還原後叢集回到快照的時間點，用 GitOps 的叢集再從 Git 同步一次。' },
      { b: '憑證要有到期告警', t: 'kubeadm 產生的元件憑證預設 1 年：`kubeadm certs check-expiration`、`kubeadm certs renew all` 後重建靜態 Pod、重新複製 `admin.conf`。到期日放進監控，告警也要涵蓋 etcd、節點 NotReady 與磁碟壓力。' },
    ],
    checklist: [
      '能從 `kubectl get pdb` 與 drain 的輸出判斷 drain 會不會卡住、卡在哪個 PDB，以及該改副本數、PDB 還是排程容量',
      '能說明 etcd 快照、Velero、GitOps 各自還原得了什麼、還原不了什麼，以及還原演練要驗證什麼',
      '能寫出 kubeadm 憑證檢查與更新的步驟，並列出叢集本身至少要有的告警',
    ],
    challenge: {
      task: '在 kind 叢集（[本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）練一次「備份 → 弄壞 → 還原」：部署 clinic-api 與資料庫並 seed 資料，記下一筆查得到的資料；匯出 namespace 的資源定義、另外 dump 資料庫；刪掉整個 namespace；照你寫的步驟還原。演練的完成條件是用 API 查回那筆資料。最後做 [這次 drain 會不會被 PDB 擋住](#/exercise/k8s-operations-1)。',
      deliver: '一份演練紀錄：備份了什麼、還原的步驟與耗時、還原後用 API 查回那筆資料的輸出',
      check: [
        '完成的證據是 API 查回刪除前記下的那筆資料，不是還原指令沒有報錯',
        '紀錄寫出還原的總耗時，並和自己訂的 RTO 比較',
        '列出這次沒備份到、還原時要另外補的東西（例如 Secret、PVC 的內容、叢集層級的物件）',
        '寫出下一次升級前要重跑的同一套步驟',
      ],
      twist: '還原用的 YAML 裡有一份是從更舊的叢集留下來的，用著已被移除的 apiVersion（例如 `policy/v1beta1` 的 PodDisruptionBudget）。先預測還原會在哪一步失敗、錯誤訊息長什麼樣，再對照 [升級前找出已被移除的 apiVersion](#/exercise/k8s-operations-2) 寫出事前找出這類檔案的方法。',
    },
    refs: [
      { label: 'Kubernetes：Safely Drain a Node', url: 'https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/' },
      { label: 'Kubernetes：Certificate Management with kubeadm', url: 'https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/' },
      { label: 'Kubernetes：Operating etcd clusters for Kubernetes', url: 'https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/' },
      { label: 'Velero 文件', url: 'https://velero.io/docs/main/' },
    ],
  },
}
