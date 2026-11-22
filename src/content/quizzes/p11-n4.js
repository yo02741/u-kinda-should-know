// 題庫：P11 新課（n4 批）：k8s-operations、k8s-node-maintenance
export default [
  {
    skill: 'k8s-operations',
    questions: [
      {
        q: '上游 Kubernetes 的版本與支援方式，對一座地端自建的叢集代表什麼？',
        options: [
          '只要持續套用同一個次版本的最新修補版，就能一直拿到安全修補，不必換次版本',
          '上游同時維護三個次版本，所以可以每隔兩三年一次跨三個次版本升級',
          '每版約有 14 個月的修補，叢集每年至少要升一次，控制平面一次只能升一個次版本',
          'kubelet 可以比 API server 舊 3 個次版本，所以控制平面也可以一次跳三個次版本',
        ],
        answer: 2,
        explain: '每個次版本約 14 個月後停止修補，之後就不會再有修補版，所以叢集每年至少要換一次次版本。控制平面不能跳版：落後三版就要依序升三次，每次都要檢查與輪替節點。「維護三個次版本」說的是同時有修補的版本，不是可以一次跨過去；kubelet 可以落後 3 版是新舊版本共存的容許範圍，和升級一次能跨幾版是兩回事。',
      },
      {
        q: '叢集上週從 1.24 升到 1.25，CI 的部署開始出現下面的錯誤，叢集裡原有的 PDB 都還在。該怎麼處理？',
        code: '$ kubectl apply -f pdb.yaml\nerror: resource mapping not found for name: "clinic-api" namespace: "clinic" from "pdb.yaml": no matches for kind "PodDisruptionBudget" in version "policy/v1beta1"\nensure CRDs are installed first',
        lang: 'bash',
        options: [
          '照訊息的提示安裝 PodDisruptionBudget 的 CRD，再重跑一次部署',
          '把 manifest 的 apiVersion 改成 `policy/v1`，並檢查 `selector` 的寫法',
          '叢集裡的 PDB 接著也會被刪掉，先把控制平面降回 1.24 再說',
          '在第一台控制平面重跑 `kubeadm upgrade apply`，它會把 Git 裡的 manifest 轉成新版',
        ],
        answer: 1,
        explain: '`policy/v1beta1` 的 PodDisruptionBudget 在 1.25 停止提供。已經在叢集裡的物件不會消失，API server 改用新的版本提供它們；壞的是 Git 裡還用舊寫法的 manifest，要改成 `policy/v1`，而且空的 `selector` 從「選不到」變成「選到全部」。PDB 是內建的物件，不是 CRD；控制平面降版沒有一般性的官方支援；kubeadm 不會改 Git 裡的檔案。',
      },
      {
        q: 'kubeadm 建的叢集，某台控制平面上的 API server 一直重啟。接下來怎麼查？',
        options: [
          '用 `kubectl delete pod` 刪掉 kube-apiserver 的 Pod，讓它所屬的 Deployment 重建一個新的',
          '在那台節點執行 `docker ps` 與 `docker logs`，找出 kube-apiserver 容器的錯誤',
          '登入那台節點，用 `journalctl -u kubelet` 與 `crictl logs` 看 kubelet 與容器的 log',
          '等 controller-manager 發現它不健康，自動在另一台控制平面節點把它重建起來',
        ],
        answer: 2,
        explain: 'kubeadm 的控制平面元件是靜態 Pod：kubelet 直接讀 `/etc/kubernetes/manifests/` 的 YAML 啟動它們，不屬於任何 Deployment，`kubectl delete pod` 重啟不了，controller-manager 也不會替它換節點。要登入節點看 kubelet 的 log 與容器的 log。1.24 起移除了 dockershim，節點上多半沒有 docker 指令，排查容器用 `crictl`。',
      },
    ],
  },
  {
    skill: 'k8s-node-maintenance',
    questions: [
      {
        q: '院內叢集要修補 k8s-node-2 的作業系統，drain 跑了十分鐘還沒結束。`report-worker` 這個 Deployment 只有 1 個副本。最合適的處理是什麼？',
        code: '$ kubectl drain k8s-node-2 --ignore-daemonsets --delete-emptydir-data\n...\nerror when evicting pods/"report-worker-7f6d4c8b9-p0c3a" -n "clinic" (will retry after 5s): Cannot evict pod as it would violate the pod\'s disruption budget.\n（同一行每 5 秒重複一次）\n\n$ kubectl get pdb -n clinic\nNAME            MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE\nclinic-api      1               N/A               1                     90d\nreport-worker   1               N/A               0                     90d',
        lang: 'bash',
        options: [
          '加上 --force 重跑 drain，它會略過 PDB，直接把卡住的 Pod 刪掉',
          '單一副本加上 minAvailable 1，允許的中斷永遠是 0；要加副本並分散到不同節點，或調整這個 PDB',
          'PDB 只在滾動更新時生效，drain 卡住是因為 report-worker 的 readiness 探針沒有通過',
          '等 drain 預設的逾時時間到，它會自動改用直接刪除的方式把 Pod 移走',
        ],
        answer: 1,
        explain: 'drain 用 Eviction API，PDB 不允許時回 429，kubectl 每 5 秒重試。report-worker 只有 1 個可用、PDB 要求至少 1 個，ALLOWED DISRUPTIONS 是 0，等多久都一樣。`--force` 是允許刪除沒有控制器的 Pod，不會略過 PDB；PDB 管的就是 drain 這類自願性中斷；drain 的 `--timeout` 預設是 0（一直等），逾時也只是失敗結束，不會改成刪除。',
      },
      {
        q: '一座一年前用 kubeadm 建的叢集，某天早上 `kubectl` 全部回 `x509: certificate has expired or is not yet valid`，已經在跑的服務還正常。第一步該怎麼做？',
        options: [
          '在每台控制平面用 kubeadm certs check-expiration 確認，再 renew all、重建靜態 Pod，並換掉過期的 kubeconfig',
          '用 kubectl --insecure-skip-tls-verify 繞過檢查，再刪除控制平面的 Pod，讓它們重建時換上新憑證',
          '重新產生叢集的 CA，再用新的 CA 簽發所有元件的憑證，一次解決之後所有的到期問題',
          '把控制平面節點的系統時間調回一週前，讓憑證暫時恢復有效，再另外排時間升級叢集',
        ],
        answer: 0,
        explain: 'kubeadm 產生的元件憑證預設 1 年，CA 是 10 年，所以要換的是元件憑證：`renew all` 之後還要重建靜態 Pod（元件不會自動重新載入所有憑證），並重新複製 `admin.conf`。跳過伺服器驗證解決不了用戶端憑證也過期的問題，而且靜態 Pod 由 kubelet 管理，用 kubectl 刪不會重建它；CA 還有效，重產 CA 要把新的信任重新發到所有節點與 kubeconfig；調時間會讓 etcd、log 時間線與其他 TLS 連線一起出問題。',
      },
      {
        q: '叢集用 GitOps 部署，每天也做 etcd 快照。`clinic` namespace 被誤刪，裡面有一個掛 PVC 的服務。這兩種備份還原不了什麼？',
        options: [
          'Deployment 與 Service 的定義：GitOps 只同步映像的版本，不含資源定義',
          'Secret：etcd 快照不包含 Secret，要另外從叢集匯出一份',
          'PV 裡的資料：etcd 快照只有叢集的物件，GitOps 只能重建定義',
          'ConfigMap：它存在節點的磁碟上，不在 etcd 裡，也不在 Git 裡',
        ],
        answer: 2,
        explain: 'etcd 快照能還原整座叢集在某個時間點的所有物件，包含 Secret（所以快照檔要加密、限制存取），但不含 PV 裡的資料；GitOps 能從 Git 重建 Deployment、Service、ConfigMap 這類定義，重建不了 Secret 與資料。volume 的資料要靠 Velero（儲存快照或檔案層級的備份）或應用程式自己的備份，叢集外的資料庫另外備份。',
      },
    ],
  },
]
