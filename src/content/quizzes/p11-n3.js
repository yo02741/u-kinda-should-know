// 題庫：P11 新課（n3 批）：k8s-rbac-tenancy、k8s-identity、k8s-multi-tenancy
export default [
  {
    skill: 'k8s-rbac-tenancy',
    questions: [
      {
        q: '在 clinic-staging 建一個 RoleBinding，roleRef 指向內建的 ClusterRole edit，主體是群組 oidc:k8s-clinic-dev。這個群組的成員能做什麼？',
        options: [
          '在所有 namespace 讀寫大部分物件，因為 roleRef 指的是 ClusterRole',
          '套用會失敗：RoleBinding 只能指向同一個 namespace 的 Role',
          '只在 clinic-staging 讀寫大部分物件，包括 Secret；其他 namespace 沒有任何權限',
          '只在 clinic-staging 讀寫，但 Secret 讀不到，因為 edit 和 view 一樣排除了 Secret',
        ],
        answer: 2,
        explain: 'ClusterRole 加 RoleBinding 的生效範圍由 RoleBinding 決定，只有它所在的 namespace；ClusterRole 在這裡只是可以重複使用的權限範本，要整個叢集生效得用 ClusterRoleBinding。RoleBinding 可以指向 Role 或 ClusterRole。排除 Secret 的是 view；edit 能讀寫 Secret，也能用這個 namespace 的任何 ServiceAccount 跑 Pod，所以給 edit 之前要想清楚。',
      },
      {
        q: '開發群組 oidc:k8s-clinic-dev 在 clinic 用 RoleBinding 綁了內建的 view。平台組用下面的指令檢查其中一位成員的權限，結果是 no，但她本人執行 kubectl get pods -n clinic 成功。原因是什麼？',
        code: '$ kubectl auth can-i get pods -n clinic --as=oidc:chen.yiting\nno',
        lang: 'bash',
        options: [
          '內建的 view 不包含 pods，她本人能成功是因為另外綁了別的角色',
          'RoleBinding 剛建立，API server 的快取更新之後 can-i 才會反映',
          'kubectl auth can-i 只能檢查 ServiceAccount，檢查人的身分一律回 no',
          '--as 只換使用者名稱、不會帶上群組，要加 --as-group=oidc:k8s-clinic-dev',
        ],
        answer: 3,
        explain: '--as 只換使用者名稱，不會去 IdP 查這個人屬於哪些群組。權限綁在群組上時，要自己用 --as-group 把群組帶上，否則常常全部是 no。view 能讀 Pod，不能讀的是 Secret。can-i 可以檢查任何身分；檢查 ServiceAccount 時 API server 會自動補上它固定的群組，所以不用另外帶。',
      },
      {
        q: '報表程式 report-bot 只需要讀 pharmacy 的 ConfigMap。有人為了省事給它一個 Role：apiGroups 是 [""]，resources 與 verbs 都寫 ["*"]，用 RoleBinding 綁在 pharmacy。它實際上能做什麼？',
        options: [
          '只能讀寫 pharmacy 的 ConfigMap 與 Pod；Secret 與 pods/exec 這類子資源要另外列出才算',
          '能列出 pharmacy 的 Secret、進容器下指令，還能刪掉 pharmacy 這個 namespace',
          '能操作所有 namespace 的 core 資源，因為 * 不受 RoleBinding 所在的 namespace 限制',
          '什麼都不能做：resources 與 verbs 同時寫 * 的規則不合法，授權時會被忽略',
        ],
        answer: 1,
        explain: '* 涵蓋所有資源與動詞：secrets 的 list 會回傳內容，pods/exec 能進容器，resources 的 * 也包含 namespaces，而 RoleBinding 所在的 namespace 本身在它的範圍內，所以能刪掉 pharmacy。RoleBinding 只在自己的 namespace 生效，別的 namespace 動不了。只想讀 ConfigMap 就只寫 configmaps 的 get。',
      },
    ],
  },
  {
    skill: 'k8s-identity',
    questions: [
      {
        q: '一位工程師調到別的部門，筆電裡還留著一份 kubeadm 產生的 admin.conf（kubeadm 1.29 以後建的叢集）。要讓這一份失效，哪個說法正確？',
        options: [
          '在叢集裡刪掉他的 User 物件，這張憑證下一次驗證就會被拒絕',
          '在院內 IdP 停用他的帳號，admin.conf 裡的憑證就跟著失效',
          '請他刪掉檔案並執行 kubectl config unset，API server 會把這張憑證列入撤銷清單、不再接受',
          'client 憑證不能撤銷：等它到期、換 CA，或刪掉 kubeadm:cluster-admins 的綁定',
        ],
        answer: 3,
        explain: 'Kubernetes 不支援撤銷 client 憑證，叢集裡也沒有 User 物件可以刪。admin.conf 是 client 憑證，和 IdP 無關，停用 IdP 的帳號只影響用 OIDC 登入的身分。1.29 起 admin.conf 的權限來自 kubeadm:cluster-admins 群組的 ClusterRoleBinding，刪掉綁定能讓外流的副本失效，但控制平面上 kubeadm 自己用的那份也一起失效。所以 admin.conf 一開始就不分給人。',
      },
      {
        q: '這是 CI 部署帳號在 clinic namespace 的 Role，裡面沒有列出 secrets。這個帳號拿不拿得到 clinic-api-secret 的內容？',
        code: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
  namespace: clinic
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "patch"]
  - apiGroups: [""]
    resources: ["services", "configmaps"]
    verbs: ["get", "create", "patch"]`,
        lang: 'yaml',
        options: [
          '拿不到：RBAC 沒有列出的資源一律拒絕，secrets 不在任何一條規則裡',
          '拿得到：能建立 Deployment，就能讓 Pod 掛載這個 namespace 的任何 Secret 再送出去',
          '拿得到：apiGroups 寫了 ""，代表 core group 的所有資源都允許，包括 secrets',
          '拿不到：除非另外給 pods/exec，否則沒辦法從容器裡讀出 Secret',
        ],
        answer: 1,
        explain: '直接對 secrets 的 get、list 會被拒絕，但能建立 Deployment（或 Pod、Job）就能寫出一個掛載 clinic-api-secret、用任何 ServiceAccount 執行的 Pod，不需要 exec，啟動指令把內容送到別處就好。apiGroups 的 "" 只是指 core group，能用哪些資源仍然由 resources 決定。部署帳號免不了這個權限，所以要靠 manifest 必須經過審查才會部署、Pod Security 標籤擋掉特權 Pod 這類補強。',
      },
      {
        q: 'GitLab 的 Runner 在叢集外，部署 job 要用 ServiceAccount gitlab-deployer 連叢集。憑證怎麼給？',
        options: [
          '用 kubectl create token 產生有期限的 token 寫進 kubeconfig，存成 protected 的 File 型變數',
          '手動建立 kubernetes.io/service-account-token 型別的 Secret，把 token 存成 masked 變數',
          '把控制平面的 admin.conf 存成 File 型變數，限制只有 protected 分支的 job 能用',
          '讓 job 讀 /var/run/secrets/kubernetes.io/serviceaccount/token，kubelet 會在到期前自動替它換成新的',
        ],
        answer: 0,
        explain: '叢集外的程式用 kubectl create token 申請有期限的 token，外流時影響範圍是一個 namespace 的部署動作，最多到 token 到期。手動建立的 Secret 型 token 不會過期；kubeconfig 是多行內容，也不能設成 masked。admin.conf 是整個叢集的管理權限，不分給 CI。投射 token 掛在 Pod 裡，叢集外的 Runner 讀不到；Runner 跑在叢集裡（Kubernetes executor）才是用 job Pod 自己的投射 token。',
      },
    ],
  },
  {
    skill: 'k8s-multi-tenancy',
    questions: [
      {
        q: 'clinic namespace 設了 requests.memory: 8Gi 的 ResourceQuota，目前已經用了 7680Mi。套用新版 Deployment 後看到下面的輸出，新的 Pod 一直沒出現。原因要去哪裡找？',
        code: '$ kubectl apply -f deployment.yaml\ndeployment.apps/clinic-api configured\n$ kubectl get pods -n clinic -l app=clinic-api    # 只有舊的 Pod',
        lang: 'bash',
        options: [
          'kubectl logs 看新 Pod 的輸出：容器啟動失敗時，Pod 才會從清單上消失',
          'kubectl get events -n kube-system：配額的事件記在系統的 namespace',
          'kubectl describe replicaset -n clinic：Events 有 exceeded quota',
          'kubectl get deployment -o yaml：配額不足時 replicas 會被改成 0',
        ],
        answer: 2,
        explain: '配額用完時 Deployment 照樣更新成功，是 ReplicaSet 建不出 Pod，錯誤寫在 ReplicaSet 的 Events（exceeded quota，後面列出要求、已用與上限）。Pod 根本沒建立，沒有 log 可看。ResourceQuota 是 namespace 裡的物件，事件也在同一個 namespace。API server 不會改 replicas。滾動更新會暫時多出 maxSurge 個 Pod，配額要留這個餘裕。',
      },
      {
        q: 'namespace 的 Pod Security 標籤是 enforce: baseline、warn: restricted。套用一個沒設 seccompProfile、其他都符合 restricted 的 Deployment，會發生什麼？',
        options: [
          'Deployment 被拒絕：warn 的等級比 enforce 嚴格時，以較嚴格的為準',
          'Deployment 建立、Pod 正常啟動，kubectl 印出 would violate PodSecurity 的警告',
          'Deployment 建立成功，但 ReplicaSet 建 Pod 時被 enforce 擋下，Pod 一直不會出現在清單上',
          '沒有任何訊息：warn 只寫進 API server 的稽核日誌，kubectl 看不到',
        ],
        answer: 1,
        explain: '三種模式各自獨立：enforce 違反就拒絕建立 Pod，warn 讓 kubectl 印出警告但照樣建立，audit 寫進稽核日誌。這個 Pod 符合 baseline，所以建得出來；warn 會檢查 Deployment 裡的 Pod 範本，apply 時就看得到警告。把 enforce 拉到 restricted 之後才會被擋，而且被擋的是 ReplicaSet 建 Pod 那一步，Deployment 本身仍然建立成功。',
      },
      {
        q: '稽核要求今後查得出「誰在什麼時間刪了哪個 namespace」。叢集目前大家共用 kubeadm 的 admin.conf，API server 沒有設定稽核政策。哪個做法能達到要求？',
        options: [
          '開啟 API server 的稽核政策並送到叢集外保存，同時讓每個人用自己的 OIDC 身分登入',
          '事後用 kubectl get events 查，刪除 namespace 的動作會留下 Event 物件',
          '開啟 API server 的稽核政策就夠了，從日誌裡的來源 IP 就能對回是誰',
          '每個人各複製一份 admin.conf、改成自己名字的檔名，稽核時依檔名區分',
        ],
        answer: 0,
        explain: '稽核日誌記的是驗證後的使用者名稱，大家共用 admin.conf 時每一筆都是 kubernetes-admin，來源 IP 只能猜；複製檔案也一樣，裡面是同一張憑證。所以要同時做兩件事：每個人有自己的身分，API server 開稽核並把日誌送到控制平面以外的地方。Event 是 Kubernetes 物件的事件，不記錄是哪個使用者做的，預設只保留一小時左右，而且 namespace 刪掉時它的 Event 也一起被刪。',
      },
    ],
  },
]
