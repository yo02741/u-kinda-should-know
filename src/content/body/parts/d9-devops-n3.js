// 領域內文（d9-devops，n3 批）：以技能 id 為 key，由 body/d9-devops.js 合併。只放這些技能：k8s-rbac-tenancy、k8s-identity、k8s-multi-tenancy
export default {
  'k8s-rbac-tenancy': {
    points: [
      { b: '先驗證、再授權，驗證的結果只有名稱與群組', t: 'API server 處理每個請求時先確認這是誰，再判斷能不能做。叢集裡沒有 User 物件，人的名稱與群組來自 client 憑證或 OIDC 的 ID token，程式是 `system:serviceaccount:<namespace>:<名稱>`。大家共用同一張憑證時，每個人的名稱都一樣，權限分不開，也查不出是誰做的。' },
      { b: 'Role 列規則，Binding 決定給誰、在哪裡生效', t: '規則是 apiGroups × resources × verbs，只有允許、沒有拒絕，權限取聯集。ClusterRole 加 RoleBinding 只在那個 namespace 生效，是重複使用權限的標準做法。binding 的 roleRef 建立後不能改，要換角色就刪掉重建。' },
      { b: '內建角色各給到哪裡', t: 'view 不能讀 Secret，也看不到 Role 與 RoleBinding；edit 能讀寫 Secret，也能用任何 ServiceAccount 跑 Pod；admin 再多管這個 namespace 的 Role 與 RoleBinding，但改不了 ResourceQuota；cluster-admin 包括 namespace 本身，用 ClusterRoleBinding 綁就是整個叢集。' },
      { b: '有幾種權限拿到的比字面上多', t: 'secrets 的 list、watch 也會回傳內容；能建立 Pod 或 Deployment、Job，就能掛載 namespace 裡任何 Secret、使用任何 ServiceAccount；pods/exec 能進容器讀環境變數；escalate、bind、impersonate 繞過授權的保護；nodes/proxy 能在節點上任何 Pod 執行指令且不留稽核紀錄；* 涵蓋以後才安裝的資源。' },
      { b: '用 kubectl auth can-i 驗證，群組要自己帶', t: '`--as` 只換使用者名稱，不會去 IdP 查群組；權限綁在群組上時要加 `--as-group`，否則常常全部是 no。檢查 ServiceAccount 時 API server 會自動補上它固定的群組。`--list` 列出某個身分在一個 namespace 的全部權限。' },
    ],
    checklist: [
      '能替一個群組寫出 Role 與 RoleBinding，並用 kubectl auth can-i 加 --as、--as-group 證明它能做該做的事、不能讀 secrets、不能 exec',
      '能說出 view、edit、admin、cluster-admin 各給到哪裡，以及 ClusterRole 用 RoleBinding 綁和用 ClusterRoleBinding 綁的生效範圍差在哪',
      '拿到一份 binding，能找出 secrets 的 get / list / watch、建立 Pod 的權限、pods/exec 與 *，並說明每一種實際上能做到什麼',
    ],
    challenge: {
      task: '先做 [從一組 binding 找出危險的權限](#/exercise/k8s-rbac-tenancy-2)。再在 kind 叢集（[本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）的 `clinic` namespace 建兩組權限：on-call 群組用深入內容的 `clinic-oncall` Role，開發群組用 RoleBinding 綁內建的 `view`。用 `kubectl auth can-i` 加 `--as`、`--as-group` 做一張角色驗收單，證據都要是指令輸出。',
      deliver: '一張角色驗收單：每一列是身分、動作、預期結果與 `can-i` 的實際輸出',
      check: [
        'on-call 群組對 patch deployments 回 yes，對 get secrets、create pods --subresource=exec、delete namespaces 回 no',
        '開發群組對 get pods 回 yes，對 get secrets 回 no',
        '同一個使用者不帶 `--as-group` 再跑一次，結果全部是 no，並寫出原因',
        '驗收單註明每一筆權限來自哪一個 binding',
      ],
      twist: '有人把開發群組在 `clinic` 的 `view` 換成 `edit`，理由是「要改 ConfigMap 除錯」。先預測驗收單裡 `can-i get secrets` 與 `can-i create pods` 會怎麼變、這個群組實際上多了哪些能力，再寫一個只多給 ConfigMap 寫入的做法。',
    },
    refs: [
      { label: 'Kubernetes：Using RBAC Authorization', url: 'https://kubernetes.io/docs/reference/access-authn-authz/rbac/' },
      { label: 'Kubernetes：Role Based Access Control Good Practices', url: 'https://kubernetes.io/docs/concepts/security/rbac-good-practices/' },
    ],
  },
  'k8s-identity': {
    map: {
      names: [
        { n: 'ServiceAccount', t: '程式在叢集裡的身分，名稱是 `system:serviceaccount:<namespace>:<名稱>`；一個程式一個，不共用 `default`。' },
        { n: '投射 token', t: 'kubelet 替 Pod 申請的 token：綁定這個 Pod、預設一小時、到期前自動換新，Pod 刪除就失效。' },
        { n: 'kubectl create token', t: '替叢集外的程式（例如 CI）產生有期限的 token，用 `--duration` 指定效期。' },
        { n: 'OIDC', t: '人用院內 IdP 的帳號登入，API server 檢查 ID token；名稱與群組來自 token 的 claim。' },
        { n: 'client 憑證', t: 'CN 是名稱、O 是群組；Kubernetes 不支援撤銷，只能等到期或換 CA。' },
        { n: 'admin.conf 與 super-admin.conf', t: 'kubeadm 產生的管理員 kubeconfig；前者留在控制平面節點，後者繞過 RBAC，離線保管。' },
        { n: 'protected 的 File 型變數', t: 'GitLab 存 kubeconfig 的方式：只給受保護分支的 job，內容寫成檔案。' },
      ],
      ask: [
        '這個身分是人還是程式；程式在叢集裡還是叢集外。',
        '部署帳號要部署哪一個 namespace、CI 會執行哪些 kubectl 指令。',
        'token 的效期多長、到期後由誰重新產生並更新變數。',
        'kubeconfig 存在哪裡、哪些分支的 job 讀得到。',
        '人的群組由誰管（AD 的哪個群組對到叢集的哪個角色）。',
      ],
      prompt: '替 GitLab CI 寫 `clinic-staging` 的部署帳號：一個 ServiceAccount `gitlab-deployer`（`automountServiceAccountToken: false`），一個只含 deployments、jobs、services、configmaps 的角色，動作只給 get、list、watch、create、patch，不給 delete、secrets、pods/exec 與 `*`；用 RoleBinding 只綁 `clinic-staging`。另外寫出用 `kubectl create token` 產生 30 天 token 的指令，以及放進 GitLab protected File 型變數的 kubeconfig。',
      verify: [
        { c: '範圍', t: '`kubectl auth can-i patch deployments -n clinic-prod --as=system:serviceaccount:clinic-staging:gitlab-deployer` 要回 no；回 yes 代表用了 ClusterRoleBinding。' },
        { c: '不該有的權限', t: '同一個身分對 get secrets、create pods --subresource=exec、delete deployments 都回 no。AI 產生的 Role 常為了省事寫 `*`。' },
        { c: 'token 有期限', t: 'kubeconfig 裡的 token 來自 `kubectl create token`；manifest 裡出現 `kubernetes.io/service-account-token` 型別的 Secret，就是不會過期的 token。' },
        { c: '訊息分得出 401 與 403', t: '權限不夠是 Forbidden，token 過期是 Unauthorized；後者要重新取得 token，改 Role 沒有用。' },
        { c: '不需要 token 的 Pod', t: '不呼叫 Kubernetes API 的程式，Pod 裡 `/var/run/secrets/kubernetes.io/serviceaccount/token` 不該存在。' },
      ],
    },
    points: [
      { b: '叢集不存使用者，人的身分來自外面', t: '人用 client 憑證或 OIDC 登入，名稱與群組來自憑證或 ID token；接院內 IdP 後權限綁群組，調職改 AD 群組，下一次取得 token 就生效。ID token 不能撤銷，效期設短。' },
      { b: 'client 憑證不能撤銷，admin.conf 不分給人', t: 'kubeadm 的 admin.conf 留在控制平面節點。1.29 起它的權限來自 kubeadm:cluster-admins 群組的 ClusterRoleBinding；super-admin.conf 屬於 system:masters，完全繞過 RBAC，外流了只能等憑證到期或換叢集的 CA，所以離線保管、取用留紀錄。' },
      { b: '程式用 ServiceAccount，token 有期限', t: 'Pod 拿到的是綁定 Pod、預設一小時、自動換新的投射 token。1.24 起建立 ServiceAccount 不再自動產生長期的 Secret 型 token，也不要自己建。不呼叫 Kubernetes API 的程式設 `automountServiceAccountToken: false`。' },
      { b: 'CI 的部署帳號：一個環境一個，只給 apply 需要的', t: 'ServiceAccount 只用 RoleBinding 綁要部署的 namespace，動作只給 get、list、watch、create、patch，不給 delete、secrets、pods/exec 與 *。能建立 Deployment 就能寫出掛載 Secret 的 Pod，這一層靠 manifest 經過 MR 審查才部署來補。' },
      { b: 'CI 怎麼拿到憑證', t: 'kubeconfig 存成 GitLab 的 protected File 型變數，token 用 kubectl create token 產生並設期限，外流時影響範圍是一個 namespace、最多到 token 到期。Runner 跑在叢集裡、用 GitLab agent 或改用 GitOps 時，GitLab 就不必存叢集的憑證。' },
    ],
    checklist: [
      '能替一個部署帳號寫出 ServiceAccount、Role 與 RoleBinding，並用 kubectl auth can-i --as 證明它不能讀 secrets、不能 exec、不能動別的 namespace',
      '能說出 client 憑證、OIDC、ServiceAccount 三種身分各自怎麼收回，以及 admin.conf 與 super-admin.conf 為什麼不能分給人',
      '能把 kubectl apply、rollout status、logs、exec 對到需要的動詞與資源，並說明為什麼不手動建立 Secret 型的長期 token',
    ],
    challenge: {
      task: '在 kind 叢集（[本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）做兩張獨立的驗收單。角色：先做 [替 CI 的部署帳號收斂權限](#/exercise/k8s-rbac-tenancy-1)，把結果套上叢集。邊界：建 `clinic-staging` 與 `clinic-prod` 兩個 namespace，部署帳號只綁 staging，再用 `kubectl create token --duration=10m` 產生 token 寫成 kubeconfig。每張單子的證據都要是指令輸出。',
      deliver: '兩張驗收單，每張列出驗收項目、指令與實際輸出',
      check: [
        '角色單：`kubectl auth can-i --as=system:serviceaccount:<ns>:<name>` 對 get secrets、create pods/exec、delete deployments 回 no，對 patch deployments 回 yes',
        '邊界單：同一個身分在 `clinic-prod` 的任何動作都回 no',
        '邊界單：用那份 kubeconfig 讀 secrets 是 Forbidden，token 到期後同一個指令變成 Unauthorized',
        '兩張單子可以各自重跑，不依賴另一張的狀態',
      ],
      twist: '有人在部署帳號的 Role 加了一條 create pods，理由是「CI 要跑 migration」。先預測角色單裡 `can-i get secrets` 會不會變，以及這張單子實際上還守不守得住，再寫出怎麼證明風險、改用什麼做法跑 migration。',
    },
    refs: [
      { label: 'Kubernetes：Authenticating', url: 'https://kubernetes.io/docs/reference/access-authn-authz/authentication/' },
      { label: 'Kubernetes：Service Accounts', url: 'https://kubernetes.io/docs/concepts/security/service-accounts/' },
      { label: 'Kubernetes：Role Based Access Control Good Practices', url: 'https://kubernetes.io/docs/concepts/security/rbac-good-practices/' },
    ],
  },
  'k8s-multi-tenancy': {
    map: {
      names: [
        { n: 'namespace', t: '權限與配額的邊界，依系統或環境切；不是安全隔離的邊界，Pod 仍共用節點核心與控制平面。' },
        { n: 'ResourceQuota', t: '限制一個 namespace 的總量：requests、limits、Pod 數、儲存、NodePort 數。' },
        { n: 'LimitRange', t: '替沒寫 resources 的容器補預設的 requests 與 limits，並限制單一容器的上限。' },
        { n: 'Pod Security Admission', t: '依 namespace 的標籤在建立 Pod 時檢查，等級是 privileged、baseline、restricted，模式是 enforce、audit、warn。' },
        { n: 'etcd 靜態加密', t: 'API server 用 EncryptionConfiguration 把 Secret 加密後才寫進 etcd，防的是 etcd 資料與備份外流。' },
        { n: '稽核政策', t: 'API server 的 `--audit-policy-file`：由上往下比對，決定每種請求記到 None、Metadata、Request 還是 RequestResponse。' },
      ],
      ask: [
        'namespace 依系統、環境還是團隊切，名稱帶不帶環境。',
        '每個 namespace 的配額數字，以及滾動更新要留多少餘裕。',
        'Pod Security 的 enforce 等級，以及導入時先開 warn 與 audit 還是直接擋。',
        '哪些系統要分節點或分叢集，理由是什麼。',
        '稽核日誌要記哪些資源、記到哪個等級、送到哪裡保存多久。',
      ],
      prompt: '替 `clinic` namespace 寫三份設定：ResourceQuota（requests.cpu 4、requests.memory 8Gi、limits.memory 12Gi、pods 30、不准開 NodePort）、LimitRange（沒寫時補 requests 100m / 128Mi 與 limits.memory 256Mi，單一容器上限 2Gi）、namespace 的 Pod Security 標籤（enforce 用 baseline，warn 與 audit 用 restricted）。另外說明配額要替滾動更新的 maxSurge 留多少餘裕。',
      verify: [
        { c: '配額有沒有生效', t: '建一個超過配額的 Deployment：Deployment 本身會成功，要看 `kubectl describe replicaset` 的 Events 有沒有 `exceeded quota`。' },
        { c: '沒寫 resources 的 Pod', t: '配額限制了 requests 或 limits、又沒有 LimitRange 補預設值時，沒寫 resources 的 Pod 會被拒絕（`failed quota … must specify`）。' },
        { c: 'Pod Security 會擋到誰', t: '`kubectl label --dry-run=server --overwrite namespace clinic pod-security.kubernetes.io/enforce=restricted` 列出現有 Pod 的違反項目，不真的改。' },
        { c: '過時的做法', t: 'AI 產生的設定出現 PodSecurityPolicy 就是舊的：PSP 在 1.25 移除。' },
        { c: 'Secret 有沒有加密', t: '在控制平面用 etcdctl 直接讀那筆 Secret，值的開頭應該是 `k8s:enc:`；既有的 Secret 要重新寫入一次才會加密。' },
      ],
    },
    points: [
      { b: 'namespace 依系統或環境切，名稱帶上環境', t: '權限、配額、稽核都以 namespace 為單位；共用元件各放自己的 namespace，應用程式不放 default。測試與正式的名稱不同（clinic-staging、clinic），測試環境的指令打到正式叢集只會回 NotFound。' },
      { b: 'ResourceQuota 限制總量，LimitRange 補預設值', t: '配額設了 requests.cpu 或 limits.memory，沒寫對應欄位的 Pod 會被拒絕。配額用完時 Deployment 照樣更新成功，錯誤在 ReplicaSet 的 Events。滾動更新會暫時多出 maxSurge 個 Pod，配額要留餘裕；配額只設上限、不保留資源。' },
      { b: 'Pod Security Admission 用 namespace 標籤擋特權容器', t: 'privileged、baseline、restricted 三個等級，enforce、audit、warn 三種模式，取代 1.25 移除的 PodSecurityPolicy。導入時先用 warn 與 audit 看會擋到什麼，再拉高 enforce。enforce 只檢查 Pod，被擋的是 ReplicaSet 建 Pod 那一步。' },
      { b: 'namespace 不是安全隔離的邊界', t: '不同 namespace 的 Pod 共用節點的核心、控制平面與叢集層級的資源，網路預設全部互通，要用 NetworkPolicy 收緊。更強的隔離是專用節點（taint、toleration、nodeSelector）或分叢集；正式與測試分叢集。' },
      { b: 'Secret 加密與稽核日誌，地端都要自己開', t: 'API server 預設把 Secret 原樣寫進 etcd，拿到備份檔就拿到全部的 Secret；EncryptionConfiguration 開靜態加密，金鑰另外備份。稽核日誌要設定 --audit-policy-file 才會記，kubeadm 預設沒有；secrets 只記 Metadata，日誌即時送到叢集外。' },
    ],
    checklist: [
      '能替一個 namespace 設定 ResourceQuota、LimitRange 與 Pod Security 標籤，並從 ReplicaSet 的 Events 分辨是配額用完還是被 Pod Security 擋下',
      '能說出 namespace 擋得住什麼、擋不住什麼，以及什麼情況要分節點或分叢集',
      '能說明 etcd 靜態加密與 API server 稽核日誌各自回答稽核的哪個問題，以及稽核政策裡 secrets 為什麼只記 Metadata',
    ],
    challenge: {
      task: '在 kind 叢集（[本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）建 `clinic-staging` namespace，設 ResourceQuota、LimitRange 與 Pod Security 的 `restricted`，做一張配額驗收單。依序套用三個 Deployment：超過配額的、沒寫 resources 的、帶特權容器的。每次套用前先寫下預測：Deployment 會不會建立成功、錯誤會出現在哪個物件上。證據都要是指令輸出。',
      deliver: '一張配額驗收單：三次套用各一列，寫出預測、指令與實際輸出',
      check: [
        '超過配額的 Deployment，ReplicaSet 的 Events 出現 `exceeded quota`',
        '沒寫 resources 的容器，建出來的 Pod 帶著 LimitRange 補上的預設值',
        '特權容器被 Pod Security 擋下並印出違反的項目',
        '預測在套用前寫下，和結果並排',
      ],
      twist: '配額剛好等於現有 Pod 的用量時，替 Deployment 換一版 image。先預測滾動更新會停在哪裡、Deployment 與 ReplicaSet 各顯示什麼，再說明配額該留多少餘裕，或 `maxSurge` 與 `maxUnavailable` 要怎麼改。',
    },
    refs: [
      { label: 'Kubernetes：Resource Quotas', url: 'https://kubernetes.io/docs/concepts/policy/resource-quotas/' },
      { label: 'Kubernetes：Pod Security Admission', url: 'https://kubernetes.io/docs/concepts/security/pod-security-admission/' },
      { label: 'Kubernetes：Pod Security Standards', url: 'https://kubernetes.io/docs/concepts/security/pod-security-standards/' },
      { label: 'Kubernetes：Encrypting Confidential Data at Rest', url: 'https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/' },
      { label: 'Kubernetes：Auditing', url: 'https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/' },
      { label: 'Kubernetes：Multi-tenancy', url: 'https://kubernetes.io/docs/concepts/security/multi-tenancy/' },
    ],
  },
}
