## 五個人共用一份 admin.conf，正式環境的 namespace 被刪了

資訊室用 kubeadm 建了測試叢集 `lab` 與正式叢集 `prod`，兩座都有 `clinic` namespace，跑門診掛號的 `clinic-api`。兩座控制平面上的 `/etc/kubernetes/admin.conf` 被合併成一份 kubeconfig 放進共用資料夾，GitLab 的部署 job 也用這一份。

某天下午，一位工程師為了查正式環境的 log 切到 `prod`。傍晚他要重建測試環境：

```bash
$ kubectl config current-context
kubernetes-admin@prod
$ kubectl delete namespace clinic
namespace "clinic" deleted
```

namespace 裡的每一個物件跟著被刪，包括不在 Git 裡的 `clinic-api-secret` 與 TLS 憑證 `clinic-tls`，門診掛號停了 50 分鐘。資安組問的四件事，一件都答不出來：

| 稽核的問題 | 現況 |
|---|---|
| 是誰刪的 | 每個人用同一張憑證，名稱都是 `kubernetes-admin`；API server 沒設稽核日誌，預設什麼都不記 |
| 這份權限給了誰 | 五台筆電、共用資料夾、GitLab 變數，還有一位上個月調走的同事 |
| 能不能收回 | client 憑證效期一年，Kubernetes 不支援撤銷 client 憑證 |
| 正式環境的 Secret 誰讀得到 | 所有拿到這份檔案的人，以及 CI 的每一個 job |

## 身分：叢集裡沒有「使用者」物件

API server 處理每個請求時先驗證（這是誰），再授權（能不能做）。驗證的結果只有使用者名稱與群組清單。叢集裡沒有 User 物件，也不能用 API 新增使用者，人是誰由叢集外的東西決定：

| 身分來源 | 名稱從哪裡來 | 怎麼收回 | 給誰 |
|---|---|---|---|
| client 憑證 | 憑證的 CN 是名稱，O 是群組 | 不能撤銷，只能等到期或換 CA | 控制平面元件、緊急用的管理員 |
| OIDC（院內的 IdP） | ID token 的 claim，例如 `preferred_username`、`groups` | IdP 停用帳號；已發出的 ID token 等它到期 | 人 |
| ServiceAccount | `system:serviceaccount:<namespace>:<名稱>` | 刪除 ServiceAccount；短期 token 自己到期 | 程式 |

人的權限綁在 OIDC 帶來的群組上；一個程式一個 ServiceAccount，不共用 `default`。

## 授權：Role、RoleBinding 與 kubectl auth can-i

| 物件 | 範圍 | 內容 |
|---|---|---|
| Role | 一個 namespace | 規則：哪些 API 群組的哪些資源，可以做哪些動作 |
| ClusterRole | 整個叢集 | 同上；還能涵蓋 nodes、namespaces 這類叢集層級的資源 |
| RoleBinding | 一個 namespace | 把 Role 或 ClusterRole 給主體（User、Group、ServiceAccount），只在這個 namespace 生效 |
| ClusterRoleBinding | 整個叢集 | 把 ClusterRole 給主體，所有 namespace 都生效 |

一條規則是三個清單的組合：`apiGroups`（core group 寫成 `""`，Deployment 在 `apps`、Job 在 `batch`）、`resources`（子資源寫成 `pods/log`、`pods/exec`）、`verbs`。下面是正式環境 on-call 用的 Role，能看 Pod 與 log、重啟 Deployment：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: clinic-oncall
  namespace: clinic
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["patch"]                      # kubectl rollout restart 是對 Deployment 做 patch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: clinic-oncall
  namespace: clinic
subjects:
  - kind: Group
    name: "oidc:k8s-clinic-oncall"        # AD 的群組名稱，加上 API server 設定的前綴
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: clinic-oncall
  apiGroup: rbac.authorization.k8s.io
```

**RBAC 只有允許，沒有拒絕**：權限取聯集，沒有任何 binding 允許就是拒絕。套用後用 `kubectl auth can-i` 驗證：

```bash
$ kubectl auth can-i delete namespaces                    # 自己能不能做
no
# 以別人的身分檢查：執行的人要有 impersonate 權限，通常是平台組
$ kubectl auth can-i get secrets -n clinic \
    --as=oidc:chen.yiting --as-group=oidc:k8s-clinic-dev
no
$ kubectl auth can-i create pods --subresource=exec -n clinic \
    --as=system:serviceaccount:clinic:gitlab-deployer
no
# 列出某個身分在某個 namespace 的全部權限（已節錄）
$ kubectl auth can-i --list -n clinic --as=system:serviceaccount:clinic:gitlab-deployer
Resources          Non-Resource URLs   Resource Names   Verbs
deployments.apps   []                  []               [get list watch create patch]
jobs.batch         []                  []               [get list watch create patch]
configmaps         []                  []               [get create patch]
```

`--as` 只換使用者名稱，不會去 IdP 查群組。權限綁在群組上時要自己加 `--as-group`，否則常常全部是 `no`。檢查 ServiceAccount 時，API server 會自動補上它固定的群組。

審一份 binding 時先找三種權限：`secrets` 的 `get`、`list`、`watch`（`list` 的回應就帶著內容）、`pods/exec`，以及規則裡的 `*`。

:::stop 讀到這裡可以先停：會寫 Role 與 RoleBinding，並用 `kubectl auth can-i --as` 的輸出證明那個身分能做該做的事、不能讀 secrets、不能 exec，審得出一份 binding 有沒有給出危險的權限。後面的四種組合、內建角色、危險權限的完整清單與評估器，在要重複使用角色或審別人寫的 binding 時再回來讀。

## Role 與 Binding 的四種組合、內建角色

應用程式內的授權模型在 [RBAC 與 ABAC 授權模型](#/skill/rbac-abac)，這裡講 Kubernetes 自己的 RBAC 怎麼寫、哪裡容易給太多。

| 角色 | Binding | 生效範圍 |
|---|---|---|
| Role | RoleBinding | Role 所在的 namespace |
| ClusterRole | RoleBinding | 只有 RoleBinding 所在的 namespace |
| ClusterRole | ClusterRoleBinding | 所有 namespace，加上叢集層級的資源 |
| Role | ClusterRoleBinding | 不允許 |

ClusterRole 加 RoleBinding 最常用：權限寫一次，每個 namespace 各綁一次。內建四個給人用的 ClusterRole：

| ClusterRole | 用 RoleBinding 綁時 | 要注意的 |
|---|---|---|
| `view` | 讀大部分物件 | 不能讀 Secret，看不到 Role 與 RoleBinding |
| `edit` | 讀寫大部分物件 | 能讀寫 Secret，能用 namespace 裡任何 ServiceAccount 跑 Pod，等於擁有它們的權限 |
| `admin` | `edit` 加上管理這個 namespace 的 Role 與 RoleBinding | 不能改 ResourceQuota 與 namespace 本身 |
| `cluster-admin` | namespace 裡的一切，包括 namespace 本身 | 用 ClusterRoleBinding 綁就是整個叢集；`admin.conf` 的權限也是它 |

門診系統的分法：開發群組在測試環境拿 `edit`，在正式的 `clinic` 只拿 `view`；on-call 群組拿上面的 `clinic-oncall`；`cluster-admin` 只用 ClusterRoleBinding 給平台組兩個人的 OIDC 身分。

- RBAC 只有允許：[RBAC 與 ABAC](#/skill/rbac-abac) 的「拒絕優先」在這裡寫不出來；需要禁止規則時，要在 admission 層加政策（例如 1.30 起正式提供的 ValidatingAdmissionPolicy）。
- binding 的 `roleRef` 建立後不能改，要換角色就刪掉重建，管理主體清單的人因此不能順手把 binding 指到更大的角色。

## 危險的權限

| 權限 | 實際能做什麼 |
|---|---|
| `secrets` 的 `get`、`list`、`watch` | 讀出內容。`list` 與 `watch` 的回應就帶著內容，只給 list 擋不住 |
| 建立 Pod，或會產生 Pod 的 Deployment、Job、CronJob | Pod 能掛載 namespace 裡任何 Secret、指定任何 ServiceAccount；能跑特權 Pod 就能碰到節點 |
| `pods/exec`、`pods/attach` | 在容器裡下指令，讀到環境變數裡的密碼。部分版本透過 WebSocket 連線時只檢查 `get`（1.35 起預設恢復要求 `create`），任何動詞都不要給 |
| `escalate`、`bind` | 跳過「只能授予自己已有的權限」這層檢查，建立比自己大的權限 |
| `impersonate` | 以別人的身分操作 |
| `nodes/proxy` | 直接呼叫 kubelet，在節點上任何 Pod 裡執行指令，不經過 admission、不留稽核紀錄；`get` 就夠 |
| `serviceaccounts/token` 的 `create` | 替既有的 ServiceAccount 發 token |
| namespace 的 `patch` | 改 namespace 的標籤，把 Pod Security 的等級調低 |
| 規則裡的 `*` | 涵蓋現在與以後的所有動詞或資源，之後裝的 CRD 也算；`resources` 與 `verbs` 都寫 `*`，上面每一項都在內 |

## 實際程式：一個 RBAC 評估器

把上面的角色與 binding 寫成資料，照 RBAC 的規則判斷：找出符合主體的 binding，RoleBinding 只在自己的 namespace 生效，規則的三個清單都要對上，有一條允許就允許。內建的 `view` 是簡化版，實際內容用 `kubectl describe clusterrole view` 看。

```python run
# 角色的 key：("ClusterRole", 名稱) 或 ("Role", namespace, 名稱)
ROLES = {
    ("ClusterRole", "cluster-admin"): [
        {"apiGroups": ["*"], "resources": ["*"], "verbs": ["*"]},
    ],
    ("ClusterRole", "view"): [                     # 內建 view 的簡化版：沒有 secrets
        {"apiGroups": [""], "resources": ["pods", "pods/log", "services", "configmaps", "events"],
         "verbs": ["get", "list", "watch"]},
        {"apiGroups": ["apps"], "resources": ["deployments", "replicasets"], "verbs": ["get", "list", "watch"]},
    ],
    ("ClusterRole", "app-deployer"): [
        {"apiGroups": ["apps"], "resources": ["deployments"], "verbs": ["get", "list", "watch", "create", "patch"]},
        {"apiGroups": ["batch"], "resources": ["jobs"], "verbs": ["get", "list", "watch", "create", "patch"]},
        {"apiGroups": [""], "resources": ["services", "configmaps"], "verbs": ["get", "create", "patch"]},
    ],
    ("Role", "clinic", "clinic-oncall"): [
        {"apiGroups": [""], "resources": ["pods", "pods/log", "events"], "verbs": ["get", "list", "watch"]},
        {"apiGroups": ["apps"], "resources": ["deployments"], "verbs": ["get", "list", "watch", "patch"]},
    ],
    ("Role", "pharmacy", "quick-fix"): [           # 只想讓報表程式讀 ConfigMap，為了省事寫了 *
        {"apiGroups": [""], "resources": ["*"], "verbs": ["*"]},
    ],
}

# binding：(種類, namespace, 名稱, 角色的 key, 主體清單)；ClusterRoleBinding 的 namespace 是 None
BINDINGS = [
    # kubeadm 1.29 起，admin.conf 的憑證屬於 kubeadm:cluster-admins 群組，權限來自這個綁定
    ("ClusterRoleBinding", None, "kubeadm:cluster-admins", ("ClusterRole", "cluster-admin"),
     [("Group", "kubeadm:cluster-admins")]),
    ("ClusterRoleBinding", None, "platform-admins", ("ClusterRole", "cluster-admin"),
     [("Group", "oidc:k8s-platform-admins")]),
    ("RoleBinding", "clinic", "clinic-dev-view", ("ClusterRole", "view"),
     [("Group", "oidc:k8s-clinic-dev")]),
    ("RoleBinding", "clinic", "clinic-oncall", ("Role", "clinic", "clinic-oncall"),
     [("Group", "oidc:k8s-clinic-oncall")]),
    ("RoleBinding", "clinic", "gitlab-deployer", ("ClusterRole", "app-deployer"),
     [("ServiceAccount", "clinic", "gitlab-deployer")]),
    ("RoleBinding", "pharmacy", "gitlab-deployer", ("ClusterRole", "app-deployer"),
     [("ServiceAccount", "pharmacy", "gitlab-deployer")]),
    ("RoleBinding", "pharmacy", "report-bot", ("Role", "pharmacy", "quick-fix"),
     [("ServiceAccount", "pharmacy", "report-bot")]),
]


def person(name, *groups):
    return {"user": name, "groups": list(groups) + ["system:authenticated"]}


def sa(ns, name):
    return {"user": f"system:serviceaccount:{ns}:{name}",
            "groups": ["system:serviceaccounts", f"system:serviceaccounts:{ns}", "system:authenticated"]}


def subject_matches(subject, who):
    if subject[0] == "User":
        return who["user"] == subject[1]
    if subject[0] == "Group":
        return subject[1] in who["groups"]
    _, ns, name = subject                          # ServiceAccount
    return who["user"] == f"system:serviceaccount:{ns}:{name}"


def rule_matches(rule, group, resource, verb):
    def has(values, want):
        return "*" in values or want in values
    sub_wild = "/" in resource and resource.split("/")[0] + "/*" in rule["resources"]   # pods/* 涵蓋子資源
    return (has(rule["apiGroups"], group) and (has(rule["resources"], resource) or sub_wild)
            and has(rule["verbs"], verb))


def can(who, verb, resource, namespace=None, group=""):
    """namespace 物件本身的請求（例如刪掉 namespace clinic），namespace 就是它自己的名字"""
    for kind, b_ns, b_name, role_key, subjects in BINDINGS:
        if not any(subject_matches(s, who) for s in subjects):
            continue
        if kind == "RoleBinding" and b_ns != namespace:      # RoleBinding 只在自己的 namespace 生效
            continue
        for rule in ROLES.get(role_key, []):               # 找不到角色：這個 binding 不給任何權限
            if rule_matches(rule, group, resource, verb):
                where = b_name if kind == "ClusterRoleBinding" else f"{b_ns}/{b_name}"
                return True, f"{kind} {where} → {role_key[0]} {role_key[-1]}"
    return False, "沒有任何 binding 允許（RBAC 沒有拒絕規則，沒給就是不行）"


def show(label, who, verb, resource, ns=None, group=""):
    ok, why = can(who, verb, resource, ns, group)
    if resource == "namespaces":
        target = f"namespace {ns}"
    else:
        target = (group + "/" if group else "") + resource + (f" -n {ns}" if ns else "")
    print(f"  {'✓' if ok else '✗'} {label}：{verb} {target}")
    print(f"      {why}")


admin_conf = person("kubernetes-admin", "kubeadm:cluster-admins")
chen = person("oidc:chen.yiting", "oidc:k8s-clinic-dev")
wang = person("oidc:wang.jiahao", "oidc:k8s-clinic-dev", "oidc:k8s-clinic-oncall")
deployer = sa("clinic", "gitlab-deployer")
pharmacy_deployer = sa("pharmacy", "gitlab-deployer")
report_bot = sa("pharmacy", "report-bot")

print("1. 事故當時：每個人都用 admin.conf")
show("kubernetes-admin", admin_conf, "delete", "namespaces", "clinic")

print("\n2. 換成各自的身分")
show("chen.yiting", chen, "delete", "namespaces", "clinic")
show("chen.yiting", chen, "get", "pods", "clinic")
show("chen.yiting", chen, "get", "secrets", "clinic")
show("wang.jiahao", wang, "patch", "deployments", "clinic", "apps")
show("wang.jiahao", wang, "create", "pods/exec", "clinic")
show("wang.jiahao（--as 沒帶群組）", person("oidc:wang.jiahao"), "patch", "deployments", "clinic", "apps")

print("\n3. 同一個 ClusterRole 用 RoleBinding 綁：只在那個 namespace 生效")
show("clinic 的部署帳號", deployer, "patch", "deployments", "clinic", "apps")
show("clinic 的部署帳號", deployer, "patch", "deployments", "pharmacy", "apps")
show("clinic 的部署帳號", deployer, "get", "secrets", "clinic")
show("pharmacy 的部署帳號", pharmacy_deployer, "patch", "deployments", "pharmacy", "apps")

print("\n4. resources 與 verbs 都寫 *，原本只想讀 ConfigMap")
for verb, res in [("get", "configmaps"), ("list", "secrets"), ("create", "pods/exec"), ("delete", "namespaces")]:
    show("report-bot", report_bot, verb, res, "pharmacy")
show("report-bot", report_bot, "get", "configmaps", "clinic")


def effective(who):
    """列出這個主體在每個範圍拿到的規則"""
    rows = []
    for kind, b_ns, b_name, role_key, subjects in BINDINGS:
        if not any(subject_matches(s, who) for s in subjects):
            continue
        scope = "整個叢集" if kind == "ClusterRoleBinding" else f"namespace {b_ns}"
        for rule in ROLES.get(role_key, []):
            groups = ",".join(g or "core" for g in rule["apiGroups"])
            wild = "  ← 萬用字元" if "*" in rule["resources"] + rule["verbs"] + rule["apiGroups"] else ""
            rows.append(f"  {scope}  {groups}  {','.join(rule['resources'])}: {' '.join(rule['verbs'])}{wild}")
    return rows or ["  （沒有任何權限）"]


print("\n5. 有效權限")
for label, who in [("clinic 的部署帳號", deployer), ("wang.jiahao", wang), ("report-bot", report_bot)]:
    print(label)
    print("\n".join(effective(who)))
```

輸出裡要看的：

- 第 1 組不管誰執行，結果與紀錄都只有 `kubernetes-admin`。
- 第 2 組最後兩行是同一個人、同一個動作，差別只在群組有沒有帶上；`kubectl auth can-i --as` 忘了 `--as-group`，會得到這種 `✗`。
- 第 3 組的兩個部署帳號共用一個 ClusterRole，各自只能動自己的 namespace。
- 第 4 組的 `quick-fix` 原本只為了讀 ConfigMap，結果能列出 Secret、進容器下指令，還能刪掉整個 `pharmacy` namespace：`resources: ["*"]` 包含 `namespaces`，而 RoleBinding 所在的 namespace 本身也在它的範圍內。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `Error from server (Forbidden): secrets is forbidden: User "system:serviceaccount:clinic:gitlab-deployer" cannot list resource "secrets" in API group "" in the namespace "clinic"` | 403：身分驗證過了，但沒有 binding 允許 | 拿訊息裡的使用者、動詞、資源、API 群組、namespace 逐一對照 Role 與 binding；這一則是預期結果 |
| `… cannot patch resource "deployments" in API group "apps" in the namespace "pharmacy"` | RoleBinding 建在別的 namespace | 在要操作的 namespace 建 binding |
| `kubectl auth can-i --as=…` 說 `no`，本人操作卻成功 | 權限綁在群組上，沒加 `--as-group` | 把群組一起帶上 |
| `The RoleBinding "clinic-oncall" is invalid: roleRef: Invalid value: …: cannot change roleRef` | `roleRef` 不能修改 | 刪掉 binding 再建立 |
| `… is attempting to grant RBAC permissions not currently held` | 建立 Role 或 binding 的人自己沒有這些權限 | 由擁有這些權限的人建立，不要為此給 `bind` 或 `escalate` |

## 動手

1. 執行上面的評估器：把 `clinic` 的 `gitlab-deployer` 那筆 binding 改成 `"ClusterRoleBinding"`，看第 3 組的 `pharmacy` 那一行怎麼變；再把 `quick-fix` 改成只有 `configmaps` 的 `get`，看第 4 組還剩哪一行是 `✓`。
2. 做本課的程式題：`k8s-rbac-tenancy-2` 從一組 binding 找出危險的權限。
3. 在本機的 kind 叢集上練習（建立叢集並部署 `clinic-api` 的方式見 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)）：套用必讀的 `clinic-oncall` Role 與 RoleBinding，執行 `kubectl auth can-i patch deployments -n clinic --as=oidc:wang.jiahao --as-group=oidc:k8s-clinic-oncall`，再拿掉 `--as-group` 執行一次，對照評估器第 2 組的最後兩行；接著用同一組 `--as` 與 `--as-group` 確認 `get secrets` 與 `create pods --subresource=exec` 都是 `no`。
4. 替團隊列一張表：每個人、每支程式各是什麼身分，在哪些 namespace 綁了哪些角色，每一筆 `edit`、`admin`、`cluster-admin` 都要說得出理由。
5. 人怎麼用院內帳號登入、程式的 ServiceAccount 與 CI 的部署帳號，接著讀 [Kubernetes 身分：OIDC、ServiceAccount 與 CI 部署帳號](#/skill/k8s-identity)；namespace、配額、Pod Security 與稽核日誌在 [Kubernetes 多租戶：namespace、配額、Pod Security 與稽核日誌](#/skill/k8s-multi-tenancy)。
