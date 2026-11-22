## 共用的 admin.conf 收不回來，CI 也拿著它

這一課接在 [Kubernetes 權限](#/skill/k8s-rbac-tenancy) 之後。那一課的事故裡，五個人與 GitLab 的部署 job 共用同一份 kubeadm 的 `admin.conf`。事故之後要把它換掉，卡在兩件事：

- 這張 client 憑證效期一年，Kubernetes 不支援撤銷 client 憑證，上個月調走的同事手上那一份還能用。
- 部署 job 只需要更新 `clinic` 的 Deployment，拿到的卻是整個叢集的管理權限，CI 的每一個 job 都讀得到正式環境的 Secret。

| 誰 | 換成什麼身分 | 在哪裡讀 |
|---|---|---|
| 程式（Pod、CI 的部署 job） | 各自的 ServiceAccount，token 有期限 | 下面兩章 |
| 人 | 院內帳號經 OIDC 登入，權限綁群組 | 停靠點之後 |
| 緊急用的管理員 | `super-admin.conf`，離線保管 | 停靠點之後 |

## 程式的身分：ServiceAccount 與投射 token

每個 namespace 都有一個 `default` ServiceAccount，Pod 沒指定 `serviceAccountName` 就用它。Pod 拿到的是投射（projected）token：kubelet 透過 TokenRequest API 申請，掛在 `/var/run/secrets/kubernetes.io/serviceaccount/token`，綁定這個 Pod，效期預設一小時、到期前自動換新，Pod 刪除就失效。

| 版本 | 變化 |
|---|---|
| 1.22 | 投射 token 成為正式功能，取代不會過期的 Secret 型 token |
| 1.24 | 建立 ServiceAccount 不再自動產生 Secret 型的長期 token（1.26 成為正式行為） |
| 1.29 | 自動產生的舊 token 超過一年沒用會被標記失效，再一年沒用就清除（1.30 成為正式行為） |

- 不呼叫 Kubernetes API 的程式（`clinic-api` 就是）設 `automountServiceAccountToken: false`，Pod 裡就沒有 token 可偷。
- 不要手動建立 `kubernetes.io/service-account-token` 型別的 Secret 拿不會過期的 token。叢集外的程式用 `kubectl create token <名稱> --duration=…` 申請有期限的，管法見 [金鑰的範圍與壽命](#/skill/key-scope-lifetime)。
- 一個程式一個 ServiceAccount，不共用 `default`，權限才分得開，稽核日誌也看得出是誰。

## CI 的部署帳號：一個環境一個 ServiceAccount

每個環境一個 ServiceAccount，只綁它要部署的 namespace，動作只給 `kubectl apply`、`rollout status`、`wait` 用得到的：

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: gitlab-deployer
  namespace: clinic
automountServiceAccountToken: false       # 只給叢集外的 CI 用，不掛進任何 Pod
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: app-deployer                      # 叢集裡寫一次，每個要部署的 namespace 各綁一次
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "patch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]                   # migration Job：建立後等它完成
    verbs: ["get", "list", "watch", "create", "patch"]
  - apiGroups: [""]
    resources: ["services", "configmaps"]
    verbs: ["get", "create", "patch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "create", "patch"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "create", "patch"]
  - apiGroups: [""]
    resources: ["pods", "events"]         # 部署失敗時印出狀態，只讀
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: gitlab-deployer
  namespace: clinic                       # 只在這個 namespace 生效
subjects:
  - kind: ServiceAccount
    name: gitlab-deployer
    namespace: clinic
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: app-deployer
```

這份權限沒有 `delete`、`secrets`、`pods/exec` 與任何 `*`。Secret 由管理者建立或由秘密管理同步；刪除舊資源由人用自己的身分做，稽核日誌留下的是那個人的名字。殘留的風險：能建立 Deployment，就能寫出掛載 `clinic-api-secret` 的 Pod，把內容送到叢集外。這一層靠 manifest 必須經過 MR 審查、合進受保護分支才會部署（見 [GitLab CI/CD 實戰](#/skill/gitlab-cicd)），以及 namespace 的 Pod Security 標籤（見 [Kubernetes 多租戶](#/skill/k8s-multi-tenancy)）。

套用後以部署帳號執行 `kubectl get secrets -n clinic`，應該看到 `Forbidden`（403：身分驗證過了，但沒有 binding 允許），這是預期結果。token 過期後，同一個指令變成 `error: You must be logged in to the server (Unauthorized)`（401）。兩則訊息的對照在最後的「常見錯誤與錯誤訊息」。

:::stop 讀到這裡可以先停：會替一支程式建 ServiceAccount，用 RoleBinding 只綁它要部署的 namespace，並用 `can-i` 證明它在別的 namespace 什麼都不能做。後面的 token 與 kubeconfig 怎麼交給 CI、kubectl 指令需要哪些動詞，在要把部署帳號接上 GitLab 時回來讀；admin.conf 與 OIDC，在要替人換登入方式時再讀。

## CI 怎麼連叢集：有期限的 token 與 kubeconfig

CI 連叢集的方式：

| 做法 | CI 拿什麼連叢集 | 取捨 |
|---|---|---|
| kubeconfig 存成 protected 的 File 型變數 | `kubectl create token` 產生、有期限的 token | 最簡單；到期要重新產生並更新變數。kubeconfig 是多行內容，不能設成 masked |
| Runner 跑在叢集裡（Kubernetes executor） | job Pod 自己的投射 token | GitLab 裡不存憑證；部署帳號放在 Runner 的 namespace，再用 RoleBinding 授權到 `clinic` |
| GitLab agent for Kubernetes | 叢集裡的 agent 主動連回 GitLab | API server 不必對 Runner 開放；設定以 GitLab 文件為準 |
| GitOps（Argo CD、Flux） | CI 不碰叢集，只推 image、改 manifest | 控制器在叢集裡拉 Git，見 [Helm、Kustomize 與 GitOps](#/skill/k8s-helm-gitops) |

第一種的做法：

```bash
# 平台組用自己的身分執行：產生 30 天的 token（API server 的設定可能把期限縮短）
kubectl create token gitlab-deployer -n clinic --duration=720h
```

```yaml
# 存成 GitLab 的 File 型、protected 變數 KUBECONFIG；kubectl 會讀這個環境變數指向的檔案
apiVersion: v1
kind: Config
clusters:
  - name: prod
    cluster:
      server: https://k8s-prod.hospital.example:6443
      certificate-authority-data: <叢集 CA 憑證的 base64>
users:
  - name: gitlab-deployer
    user:
      token: <上面產生的 token>
contexts:
  - name: prod-clinic
    context: { cluster: prod, user: gitlab-deployer, namespace: clinic }
current-context: prod-clinic
```

這個 token 外流時，影響範圍是一個 namespace 的部署動作，最多 30 天。

## kubectl 指令需要哪些動詞

RBAC 只管到「動詞 × 資源」，管不到欄位：給了 Deployment 的 `patch`，能 `rollout restart`，也能改 image。

| 指令 | 需要的動詞 |
|---|---|
| `kubectl get pod <名稱>`、`kubectl get pods` | `get`、`list` |
| `kubectl rollout status`、`kubectl wait` | `get`、`list`、`watch` |
| `kubectl apply`（物件不存在時） | `get`、`create` |
| `kubectl apply`（已存在）、`set image`、`rollout restart` | `get`、`patch` |
| `kubectl logs` | `pods/log` 的 `get` |
| `kubectl exec` | `pods/exec` 的 `create` |

## admin.conf 與 super-admin.conf 為什麼不能外流

`clinic-api` 的 manifest 來自 [實作路線第 10 階段](#/project/k8s)。事故當天 manifest 重新套用只要幾分鐘，時間花在把 Secret 從保管的地方找回來。

kubeadm 的文件寫明 `admin.conf` 要留在控制平面節點，不要分給其他使用者。kubeadm 1.29 起，`admin.conf` 的權限來自 `kubeadm:cluster-admins` 群組的 ClusterRoleBinding，刪掉綁定能讓外流的副本失效，但控制平面上 kubeadm 自己用的那份也一起失效。新建叢集時同時產生的 `super-admin.conf` 屬於 `system:masters` 群組，完全繞過 RBAC，外流了只能等憑證到期或換叢集的 CA。

## 人的身分：用 OIDC 接院內的 IdP

院內的帳號在 AD，前面有一個 IdP（見 [企業身分：LDAP、AD、SAML 與 SCIM](#/skill/enterprise-identity)）。叢集把它當成 OIDC 的發行者：工程師用院內帳號加 MFA 登入拿到 ID token，API server 檢查簽章、`iss`、`aud` 與效期（見 [OAuth 2.0 與 OpenID Connect](#/skill/oauth-oidc)）。

```yaml
# /etc/kubernetes/auth/authn.yaml；API server 加上 --authentication-config=/etc/kubernetes/auth/authn.yaml
apiVersion: apiserver.config.k8s.io/v1   # 1.34 起是 v1；1.30–1.33 是 beta 的 v1beta1
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: https://idp.hospital.example/realms/staff
      audiences: ["kubernetes"]           # IdP 上替叢集建立的 client id
      certificateAuthority: |             # IdP 的憑證由院內 CA 簽發時，放院內 CA 的根憑證
        -----BEGIN CERTIFICATE-----
        ...
        -----END CERTIFICATE-----
    claimMappings:
      username:
        claim: preferred_username
        prefix: "oidc:"                   # 加前綴，避免和 system: 開頭的內建名稱撞名
      groups:
        claim: groups
        prefix: "oidc:"
```

也可以用 `--oidc-issuer-url`、`--oidc-groups-claim` 這組啟動參數設定（較舊的版本只能用這種），兩種方式不能同時使用。工程師的 kubeconfig 不再放憑證，只寫怎麼取得 token：

```yaml
users:
  - name: hospital-oidc
    user:
      exec:                               # 需要 token 時執行這個程式；這裡以 kubelogin 為例，參數以它的文件為準
        apiVersion: client.authentication.k8s.io/v1
        command: kubectl
        args:
          - oidc-login
          - get-token
          - --oidc-issuer-url=https://idp.hospital.example/realms/staff
          - --oidc-client-id=kubernetes
```

```bash
$ kubectl auth whoami          # 1.28 起
ATTRIBUTE   VALUE
Username    oidc:chen.yiting
Groups      [oidc:k8s-clinic-dev system:authenticated]
```

這份 kubeconfig 沒有秘密，可以放在內部 wiki。權限綁在群組上，群組由 AD 管：調職時改 AD 群組，下一次取得 token 就生效。ID token 不能撤銷，效期設短，常見是幾分鐘到一小時。`super-admin.conf` 移到離線保管，只在 RBAC 設壞、所有人都進不去時取用，取用要留紀錄。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `Error from server (Forbidden): secrets is forbidden: User "system:serviceaccount:clinic:gitlab-deployer" cannot list resource "secrets" in API group "" in the namespace "clinic"` | 403：身分驗證過了，但沒有 binding 允許 | 拿訊息裡的使用者、動詞、資源、API 群組、namespace 逐一對照 Role 與 binding；這一則是預期結果 |
| `error: You must be logged in to the server (Unauthorized)` | 401：token 過期、issuer 或 audience 對不上、憑證過期 | 重新取得 token；OIDC 設定錯誤的原因在 API server 的 log |
| Pod 沒寫 `serviceAccountName`，稽核日誌裡好幾支程式都是同一個 `system:serviceaccount:<namespace>:default` | Pod 沒指定時用 namespace 的 `default` ServiceAccount | 一個程式一個 ServiceAccount；不呼叫 Kubernetes API 的程式設 `automountServiceAccountToken: false` |
| GitLab 的 `KUBECONFIG` 變數不能設成 masked | kubeconfig 是多行內容 | 存成 protected 的 File 型變數，token 用 `kubectl create token` 產生並設期限 |

## 動手

1. 做本課的程式題：`k8s-rbac-tenancy-1` 替 `clinic-staging` 的部署帳號寫 ServiceAccount、Role 與 RoleBinding。
2. 在本機的 kind 叢集上練習（建立叢集並部署 `clinic-api` 的方式見 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）：
   - 建立 `clinic-staging` namespace，套用程式題的解答，用 `kubectl auth can-i --list -n clinic-staging --as=system:serviceaccount:clinic-staging:gitlab-deployer` 列出權限，確認 `get secrets` 與 `create pods --subresource=exec` 都是 `no`。
   - 用 `kubectl create token gitlab-deployer -n clinic-staging --duration=10m` 產生 token，照上面的格式寫一份 kubeconfig（`server` 與 CA 從 `kubectl config view --minify --raw` 複製），執行 `KUBECONFIG=./deployer.yaml kubectl get secrets -n clinic-staging` 看 Forbidden；10 分鐘後再執行，看它變成 Unauthorized。
3. 用 `kubectl auth whoami` 看自己現在的使用者名稱與群組，再對照 `admin.conf` 那一章，判斷手上這份 kubeconfig 屬於哪一種身分來源、收不收得回來。
4. namespace 怎麼切、配額、Pod Security、Secret 的保護與稽核日誌，接著讀 [Kubernetes 多租戶：namespace、配額、Pod Security 與稽核日誌](#/skill/k8s-multi-tenancy)。
