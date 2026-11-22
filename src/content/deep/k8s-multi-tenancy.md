## 一個 Job 寫錯迴圈，別的系統的 Pod 排不上去

這一課接在 [Kubernetes 身分：OIDC、ServiceAccount 與 CI 部署帳號](#/skill/k8s-identity) 之後。身分與 RBAC 決定誰能在哪個 namespace 做什麼，擋不住有權限的人或程式用掉整座叢集。門診的 `clinic`、藥局的 `pharmacy` 與報表共用同一座叢集：一個系統的 HPA 擴到上限，或某個 Job 寫錯迴圈開了幾百個 Pod，會把節點吃光，其他系統的 Pod 排不上去。

| 要擋的事 | 用什麼 | 在哪裡讀 |
|---|---|---|
| 測試環境的指令打到正式環境 | namespace 的切法與名稱 | 下一章 |
| 一個系統吃光節點 | ResourceQuota、LimitRange | 再下一章 |
| Pod 從容器碰到節點 | Pod Security Admission | 停靠點之後 |
| 答不出誰讀了 Secret、誰做了什麼 | etcd 靜態加密、稽核日誌 | 停靠點之後 |

## namespace 怎麼切

| 切法 | 例子 | 要注意的 |
|---|---|---|
| 依系統 | `clinic`、`pharmacy`、`reports` | 最常見：權限、配額、稽核都以系統為單位；共用元件（Ingress controller、監控）各放自己的 namespace |
| 依環境 | `clinic-staging`、`clinic` | 同一座叢集放多個環境時用；分叢集時名稱也帶上環境，同一個指令才不會在兩邊都成立 |
| 依團隊 | `team-opd`、`team-nursing` | 組織調整時不好搬，通常和依系統搭配 |

[Kubernetes 權限](#/skill/k8s-rbac-tenancy) 那次誤刪 namespace 的事故之後，測試叢集的 namespace 改名為 `clinic-staging`，測試環境的指令打到正式叢集只會回 NotFound。context 的名稱寫出環境（`prod-clinic`），shell 的提示字元顯示目前的 context。應用程式不放 `default`。

## ResourceQuota 與 LimitRange

ResourceQuota 限制一個 namespace 的總量，LimitRange 替沒寫 resources 的容器補預設值：

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: clinic-quota
  namespace: clinic
spec:
  hard:
    requests.cpu: "4"                     # 所有 Pod 的 CPU requests 加總上限
    requests.memory: 8Gi
    limits.memory: 12Gi
    pods: "30"
    requests.storage: 100Gi
    services.nodeports: "0"               # 這個 namespace 不能開 NodePort
---
apiVersion: v1
kind: LimitRange
metadata:
  name: clinic-defaults
  namespace: clinic
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 128Mi }   # 沒寫 requests 時補上
      default: { memory: 256Mi }                     # 沒寫 limits 時補上
      max: { memory: 2Gi }                           # 單一容器的上限
```

requests 與 limits 的意義見 [Kubernetes 實作：設定、探針與資源](#/skill/k8s-config-probes)。幾個行為：

- 配額設了 `requests.cpu` 或 `limits.memory`，沒寫對應欄位的 Pod 會被拒絕。配額用完時 Deployment 照樣更新成功，是 ReplicaSet 建不出 Pod，錯誤在 ReplicaSet 的 Events。
- 滾動更新會暫時多出 `maxSurge` 個 Pod，配額要留這個餘裕。
- 配額只設上限、不替 namespace 保留資源，所有 namespace 的配額加總可以超過叢集容量；要超賣多少用 [硬體資源與容量規劃](#/skill/capacity-planning) 的方法估。內建的 `admin` 改不了 ResourceQuota，上限由平台組決定。

配額最常見的兩個訊息都不在 Deployment 上，要看 ReplicaSet 的 Events：`exceeded quota` 是配額用完，`failed quota … must specify` 是配額限制了某種資源而 Pod 沒寫。完整的訊息在最後的「常見錯誤與錯誤訊息」。

:::stop 讀到這裡可以先停：交付一個 namespace 的 ResourceQuota 與 LimitRange，附上兩次套用的結果：超過配額被拒、沒寫 resources 的容器補上預設值。後面的 Pod Security 在要擋特權容器時讀；namespace 擋不住的東西，在決定要不要分節點或分叢集時讀；Secret 保護與稽核日誌，在要回答稽核「誰讀了什麼、誰做了什麼」時再回來讀。

## Pod Security Admission：擋掉特權容器

能跑特權容器、掛節點目錄、用節點網路的 Pod，可以從容器碰到節點，再碰到同節點上其他系統的 Pod。Pod Security Admission（1.25 起正式提供）在建立 Pod 時依 namespace 的標籤檢查；它取代了 PodSecurityPolicy，PSP 在 1.25 移除，還在教 PSP 的文章在新叢集上用不了。

| 等級 | 擋掉什麼 | 適合 |
|---|---|---|
| `privileged` | 不擋 | 網路外掛、儲存外掛、監控代理 |
| `baseline` | 特權容器、`hostPath`、`hostNetwork`、`hostPID`、額外的 capabilities 等已知的提權方式 | 一般應用程式的最低要求 |
| `restricted` | baseline 加上：非 root、`allowPrivilegeEscalation: false`、捨棄所有 capabilities、設定 seccomp profile | 自己寫的服務 |

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: clinic
  labels:
    pod-security.kubernetes.io/enforce: baseline     # 違反就拒絕建立
    pod-security.kubernetes.io/warn: restricted      # 違反時 kubectl 印出警告，照樣建立
    pod-security.kubernetes.io/audit: restricted     # 違反時寫進稽核日誌，照樣建立
```

每個模式另有 `-version` 標籤（例如 `pod-security.kubernetes.io/enforce-version`），把規則固定在某個次版本，升級叢集時才不會被新版規則突然擋掉。導入時先用 `warn` 與 `audit` 看會擋到什麼，改完 manifest 再拉高 `enforce`；`kubectl label --dry-run=server` 改 `enforce` 標籤，會列出現有 Pod 有哪些違反，但不真的改。實作路線的 Deployment 已經以非 root 執行、捨棄所有 capabilities，套用時還是有一條警告：

```bash
$ kubectl apply -k k8s/overlays/production        # 輸出已節錄
Warning: would violate PodSecurity "restricted:latest": seccompProfile (pod or container "api" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")
deployment.apps/clinic-api configured
```

在 Pod 層的 `securityContext` 加上 `seccompProfile: { type: RuntimeDefault }`，就能把 `enforce` 改成 `restricted`。注意 `enforce` 只檢查 Pod：Deployment 會建立成功，被擋的是 ReplicaSet 建 Pod 那一步；`warn` 與 `audit` 會檢查 Deployment 裡的 Pod 範本，所以 apply 時就看得到。

## namespace 擋不住的東西

namespace 是權限與配額的邊界，不是安全隔離的邊界。不同 namespace 的 Pod 共用節點的核心、控制平面與叢集層級的資源（CRD、ClusterRole、節點），網路預設全部互通，要用 NetworkPolicy 收緊（見 [Kubernetes NetworkPolicy](#/skill/k8s-network-policy)）。

| 隔離程度 | 做法 | 還共用什麼 |
|---|---|---|
| 同叢集、不同 namespace | RBAC、配額、Pod Security、NetworkPolicy | 節點核心、控制平面 |
| 同叢集、專用節點 | 再用 taint、toleration、nodeSelector 讓系統只跑在自己的節點 | 控制平面 |
| 分叢集 | 各自的控制平面與節點 | 網路與機房 |

正式與測試分叢集。資料敏感程度差很多的系統（病歷與院內公告），或讓外部廠商自己部署的系統，也值得分叢集，至少分節點。

## Secret 的保護

Secret 在 API 裡只是 base64 編碼（[設定、探針與資源](#/skill/k8s-config-probes) 有示範），保護分三層。

第一層是 RBAC：定期列出哪些身分能讀正式環境的 Secret，包括綁到 `edit`、`admin`、`cluster-admin` 的，以及能在這個 namespace 建立 Pod 的。

第二層是 etcd 的靜態加密。API server 預設把 Secret 原樣寫進 etcd，拿到 etcd 的資料目錄或一份備份檔，就拿到全部的 Secret。雲端代管服務多半有對應的設定；地端要自己開：

```yaml
# /etc/kubernetes/enc/enc.yaml：每個控制平面節點放一份，權限 600
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources: ["secrets"]
    providers:
      - secretbox:                        # 第一個 provider 用來加密新寫入的資料
          keys:
            - name: key-2026-11
              secret: <32 位元組亂數的 base64，例如 head -c 32 /dev/urandom | base64>
      - identity: {}                      # 讓還沒重新寫入的舊資料讀得到；全部重寫後可以移除
```

```bash
# 1. kube-apiserver 的 static Pod 加上參數，並把 /etc/kubernetes/enc 掛進容器：
#      --encryption-provider-config=/etc/kubernetes/enc/enc.yaml
# 2. 既有的 Secret 不會自動加密，全部重新寫入一次
kubectl get secrets --all-namespaces -o json | kubectl replace -f -
# 3. 直接讀 etcd 確認：值的開頭應該是 k8s:enc:secretbox:v1:key-2026-11
ETCDCTL_API=3 etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/clinic/clinic-api-secret | hexdump -C | head -3
```

金鑰放在控制平面的檔案裡，所以這一層防的是 etcd 資料與備份外流，防不了控制平面主機被入侵。院內有 HSM 或金鑰管理服務時，`kms` v2 provider（1.29 起正式提供）把主金鑰留在外部。`aescbc` 已不建議使用，其他 provider 的取捨以官方文件的比較表為準。金鑰要另外備份、不和 etcd 備份放在一起，金鑰遺失，備份就還原不了（見 [Kubernetes 叢集維運](#/skill/k8s-operations)）。

第三層是外部秘密管理：Vault 這類服務當唯一來源、同步進叢集時，輪替與「誰讀過」的紀錄在那個服務裡；同步進來的仍然是 Secret，前兩層照做。見 [秘密管理](#/skill/secrets)。

## 稽核日誌：誰在什麼時間做了什麼

API server 只有設定了 `--audit-policy-file` 才記稽核日誌，kubeadm 預設沒有。政策由上往下比對，第一條符合的決定記錄的詳細程度：`None` 不記；`Metadata` 記誰、何時、從哪個 IP、對什麼做了什麼與狀態碼；`Request` 再加上請求內容；`RequestResponse` 再加上回應內容。

```yaml
# /etc/kubernetes/audit/policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages: ["RequestReceived"]           # 每個請求只記完成時的那一筆
rules:
  - level: None                           # 量大、沒有稽核價值
    nonResourceURLs: ["/healthz*", "/livez*", "/readyz*", "/version"]
  - level: None
    resources:
      - group: ""
        resources: ["events"]
  - level: Metadata                       # 只記誰讀寫了秘密，不記內容，否則秘密會寫進稽核日誌
    resources:
      - group: ""
        resources: ["secrets", "configmaps", "serviceaccounts/token"]
  - level: Metadata                       # 進到容器裡的操作
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]
  - level: RequestResponse                # 權限變更記下完整內容
    resources:
      - group: "rbac.authorization.k8s.io"
  - level: Request                        # 其他寫入記下送了什麼
    verbs: ["create", "update", "patch", "delete", "deletecollection"]
  - level: Metadata                       # 其餘的讀取
```

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml 的 command 加上這些；政策檔與 log 目錄要用 hostPath 掛進容器
    - --audit-policy-file=/etc/kubernetes/audit/policy.yaml
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30               # 節點上留 30 天；長期保存靠送到集中的 log 系統
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100             # 單檔超過 100 MB 就輪替
```

換成各自的身分並開啟稽核後，同樣一個刪除會留下這樣一筆（已簡化）：

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "Request",
  "stage": "ResponseComplete",
  "verb": "delete",
  "requestURI": "/api/v1/namespaces/clinic",
  "user": { "username": "oidc:lin.zhiwei", "groups": ["oidc:k8s-platform-admins", "system:authenticated"] },
  "sourceIPs": ["10.20.31.45"],
  "userAgent": "kubectl/v1.33.2 (linux/amd64)",
  "objectRef": { "resource": "namespaces", "namespace": "clinic", "name": "clinic", "apiVersion": "v1" },
  "responseStatus": { "code": 200 },
  "requestReceivedTimestamp": "2026-11-11T09:42:10.512Z",
  "annotations": {
    "authorization.k8s.io/decision": "allow",
    "authorization.k8s.io/reason": "RBAC: allowed by ClusterRoleBinding \"platform-admins\" of ClusterRole \"cluster-admin\" to Group \"oidc:k8s-platform-admins\""
  }
}
```

| 稽核問的 | 去哪裡找 |
|---|---|
| 誰在什麼時間對什麼做了什麼、憑哪一條權限 | 稽核日誌的 `user`、`verb`、`objectRef`、時間與 `authorization.k8s.io/reason` |
| 誰讀過正式環境的 Secret、誰進過容器 | 稽核日誌裡 `secrets` 的 `get`、`list` 與 `pods/exec` |
| 某個人現在能做什麼、誰核准的 | `kubectl auth can-i --list`；RBAC 的 YAML 放在 Git，變更經過 MR 核准（見 [受監管環境的變更管理](#/skill/change-management)） |
| 離職、調職什麼時候生效 | IdP 的異動紀錄；ID token 的效期就是最長的延遲 |

稽核日誌寫在控制平面節點的磁碟上，能登入那幾台主機的人就能改，所以要即時送到叢集外的集中 log 系統，保存期限依院內規範。日誌裡有員工帳號與來源 IP，比照 [日誌與稽核紀錄裡的個資](#/skill/logs-pii) 管理。

## 雲端代管的差異

| 項目 | 地端自建 | 雲端代管 |
|---|---|---|
| 人的身分 | 自己設定 API server 接院內 IdP | 多半和雲端帳號整合，由雲端的身分服務對應到 Kubernetes 的使用者與群組 |
| 稽核日誌、etcd 加密 | 自己改 API server 參數、自己收 log | 控制平面由服務商管理，通常在主控台開啟；etcd 多半預設加密 |
| 管理員憑證 | `admin.conf`、`super-admin.conf` 在自己手上 | 通常沒有這類檔案，管理權限來自雲端帳號 |
| RBAC、Pod Security、配額 | 相同 | 相同 |

具體行為依服務而定，以各家文件為準。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| Deployment 套用成功，Pod 一直沒出現；ReplicaSet 的 Events 有 `violates PodSecurity "restricted:latest"` | namespace 的 `enforce` 擋掉了 Pod | 照訊息補 securityContext；加上 `warn` 標籤，apply 時就看得到 |
| ReplicaSet 的 Events 有 `exceeded quota: clinic-quota, requested: requests.memory=512Mi, used: requests.memory=7680Mi, limited: requests.memory=8Gi` | 配額用完 | 先查是不是有東西異常擴張，再決定要不要調配額 |
| `failed quota: clinic-quota: must specify limits.memory,requests.cpu,requests.memory` | 配額限制了這些資源，Pod 沒寫 | 在 manifest 寫 `resources`，或用 LimitRange 給預設值 |
| 改了 API server 的 static Pod manifest 後，kubectl 連不上 | 參數指到的檔案沒掛進容器，或設定檔有錯，API server 起不來 | 在控制平面節點用 `crictl ps -a`、`crictl logs` 看 kube-apiserver 的錯誤 |

## 動手

1. 在本機的 kind 叢集上練習（建立叢集並部署 `clinic-api` 的方式見 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）：
   - 執行 `kubectl label --dry-run=server --overwrite namespace clinic pod-security.kubernetes.io/enforce=restricted`，看 `clinic-api`、PostgreSQL、Redis 的 Pod 各違反了什麼（加了 dry-run，標籤不會真的改）；在 overlay 的補丁替 `clinic-api` 加上 `seccompProfile`，重新套用 `kubectl apply -k k8s/overlays/kind` 後再試一次，確認它不在清單裡。
   - 在 `clinic-staging` 建立 `requests.memory: 1Gi` 的 ResourceQuota，再用 `kubectl create deployment demo --image=nginx:1.27 --replicas=3 -n clinic-staging` 建一個沒寫 resources 的 Deployment，從 `kubectl describe replicaset -n clinic-staging` 看它缺什麼；接著加一個 `defaultRequest` 是 `memory: 512Mi` 的 LimitRange，看 ReplicaSet 重試後建出幾個 Pod、第幾個被配額擋下。
2. 對照「namespace 擋不住的東西」的表，替團隊的每個系統寫下它現在在哪一級隔離、還和誰共用節點核心與控制平面。
3. 叢集的升級、etcd 備份與憑證到期，接著讀 [Kubernetes 叢集維運](#/skill/k8s-operations) 與 [Kubernetes 節點維護與備份](#/skill/k8s-node-maintenance)。
