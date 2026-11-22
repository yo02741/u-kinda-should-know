## 稽核發現別的 namespace 連得到資料庫

門診掛號的 `clinic-api` 搬上院內的 Kubernetes 叢集，放在 `clinic` namespace，旁邊有 `clinic-web` 與 PostgreSQL `clinic-db`。資安稽核開了一張單：別的 namespace 的測試 Pod 連上了 `clinic-db` 的 5432：

```bash
$ kubectl run probe -n reports --rm -it --image=busybox:1.36 -- nc -vz -w 3 clinic-db.clinic 5432
clinic-db.clinic (10.96.212.40:5432) open
```

每個 Pod 有自己的 IP，叢集內預設全部互通（見 [Kubernetes 網路](#/skill/k8s-networking)，這一課接在它之後）。沒有任何設定時，`reports` namespace 的 Pod 連得到 `clinic` 的資料庫。收緊的工具是 NetworkPolicy。

## 規則怎麼算：被選到的 Pod 變成白名單

NetworkPolicy（`networking.k8s.io/v1`）的計算方式和一般的防火牆規則不太一樣：

1. **預設全部放行**。沒有任何 policy 選到一個 Pod 時，它進出都不受限制。
2. **一旦有 policy 選到某個 Pod，該方向就變成白名單**。policy 的 `spec.podSelector` 選到 Pod，而 `policyTypes` 含 `Ingress`，這個 Pod 的進入流量就只剩規則明列的能通過；`Egress` 同理。兩個方向分開計算。
3. **規則只有允許，沒有拒絕**。多份 policy 選到同一個 Pod 時取聯集，寫的順序不影響結果。要拒絕某個來源，做法是不把它列進任何一條規則。
4. **一條連線要兩邊都放行**：來源 Pod 的 egress 允許、目的 Pod 的 ingress 也允許。已經建立的連線，回應封包自動放行，不用另外寫規則。
5. 沒寫 `policyTypes` 時，一定包含 `Ingress`，有寫 `egress` 規則才包含 `Egress`。建議永遠明寫。

另外兩件事：NetworkPolicy 擋不了 Pod 所在節點連進來的流量（官方文件列為它做不到的事之一），所以 kubelet 的探針在全擋之後通常照常運作；`ipBlock` 用來寫叢集外的位址，Pod 要用 `podSelector` 選，因為 Pod 的 IP 會變。

## 先全擋，再放行 DNS

### 第一步：全擋

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: clinic
spec:
  podSelector: {}          # 空的 selector：選到 clinic 裡的每一個 Pod
  policyTypes:
    - Ingress
    - Egress               # 兩個方向都變成白名單；沒有任何規則，所以全部擋下
```

套用這一份之後，`clinic` 裡的 Pod 什麼都連不出去，也沒有人連得進來。其他 namespace 不受影響：policy 只管它所在 namespace 的 Pod。

### 第二步：放行 DNS

全擋之後最先壞掉的是 DNS。`clinic-api` 連 `clinic-db` 之前要先解析名稱，egress 被擋，查詢送不到 `kube-system` 的 DNS Pod。錯誤訊息看起來像資料庫連不上，原因卻在名稱解析，PostgreSQL 的用戶端會印出類似：

```text
could not translate host name "clinic-db" to address: Temporary failure in name resolution
```

所以 default deny 之後的第一條，固定是放行 DNS：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: clinic
spec:
  podSelector: {}                      # clinic 裡每個 Pod 都要能查 DNS
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:           # 同一個元素裡的兩個條件：kube-system 裡的 DNS Pod
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns        # CoreDNS 常見的 label；依發行版確認
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP                # 回應太大時改用 TCP，兩個都要開
          port: 53
```

`kubernetes.io/metadata.name` 是控制平面自動加在每個 namespace 上的 label（Kubernetes 1.22 起），值就是 namespace 的名字，而且不能改，用來選 namespace 比自己加的 label 可靠。DNS Pod 的 label 依發行版而定，先用 `kubectl get pods -n kube-system --show-labels` 確認。叢集若啟用了 NodeLocal DNSCache，DNS 查詢由節點上的快取接手，規則要另外放行它的位址，寫法依設定而定，以官方文件為準。

:::stop 讀到這裡可以先停：會替一個 namespace 寫 default deny 並放行 DNS，說得出少了 DNS 那一條時程式印出的錯誤。後面的逐條放行、namespaceSelector 與 podSelector 的 AND 與 OR、連線模擬，在替服務開白名單時回來讀；CNI 有沒有執行 NetworkPolicy，在選 CNI 或規則沒有效果時再讀。

## 第三步：一條一條開

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-egress
  namespace: clinic
spec:
  podSelector:
    matchLabels:
      app: clinic-api
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:                 # 只寫 podSelector：policy 自己的 namespace（clinic）裡的 Pod
            matchLabels:
              app: clinic-db
      ports:
        - protocol: TCP
          port: 5432
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-ingress
  namespace: clinic
spec:
  podSelector:
    matchLabels:
      app: clinic-db
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: clinic-api
      ports:
        - protocol: TCP
          port: 5432
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-ingress
  namespace: clinic
spec:
  podSelector:
    matchLabels:
      app: clinic-api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: clinic-web
      ports:
        - protocol: TCP
          port: 8000                   # 容器監聽的 port，不是 Service 的 80
```

api 連 db 要兩份：api 的 egress 與 db 的 ingress，少一份都不通。`api-ingress` 的 port 是 8000：`clinic-web` 連的是 Service 的 80，但 kube-proxy 改寫之後，送到 Pod 的是 8000，NetworkPolicy 比對的是改寫後的封包。

kube-proxy 先改寫封包，所以 NetworkPolicy 比對的是 Pod（label 與容器的 port），不是 Service。規則裡沒有「允許連到 Service X」這種寫法，port 也要寫容器實際監聽的 port。

實作路線的正式環境把 PostgreSQL 留在叢集外的既有主機，那時 `api-egress` 的 `to` 改成資料庫主機的 `ipBlock`，`db-ingress` 就不需要了，寫法和 [Kubernetes 連到叢集外的舊系統](#/skill/k8s-egress) 連舊系統的那一條相同。

`clinic-web` 本身也被全擋了，Ingress controller 或 Gateway 連不進來，網站會回 504 或 502。它要一條 ingress 規則，`from` 寫 controller 所在的 namespace（再加上 controller Pod 的 label 更精確）。

## namespaceSelector 與 podSelector：同一個元素是 AND，分開是 OR

監控系統的 Prometheus 跑在 `monitoring` namespace，要抓 `clinic-api` 的 `/metrics`。下面兩份只差一個 `-`：

```yaml
# 寫法 A：一個元素，兩個條件同時成立（AND）
#   → 只有 monitoring namespace 裡、label 是 app: prometheus 的 Pod
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 8000

# 寫法 B：兩個元素，任一個成立就放行（OR）
#   → monitoring 裡的「所有」Pod，加上 clinic 裡 label 是 app: prometheus 的 Pod
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
        - podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 8000
```

寫法 B 的第一個元素只有 `namespaceSelector`，選到 `monitoring` 裡的每一個 Pod，包括某人臨時開的除錯 Pod；第二個元素只有 `podSelector`，選的是 policy 自己的 namespace（`clinic`）裡的 Pod。兩份 YAML 都合法，`kubectl apply` 不會提醒；套用前用 `kubectl describe networkpolicy` 看它展開後的說明，或用下一節的程式模擬。

## 用程式模擬：一條連線會不會被放行

下面把前面的規則寫成一個小型評估器：給定 Pod 的 namespace 與 label、一組 policy，判斷一條連線（來源、目的、協定、port）放不放行，並印出是哪一條規則決定的。selector 只實作 `matchLabels`，其餘照官方文件的語意：

```python run
import ipaddress

# 叢集裡的 Pod（示意）：namespace、label、IP
PODS = {
    "web":   {"ns": "clinic", "labels": {"app": "clinic-web"}, "ip": "10.244.1.10"},
    "api":   {"ns": "clinic", "labels": {"app": "clinic-api"}, "ip": "10.244.1.11"},
    "db":    {"ns": "clinic", "labels": {"app": "clinic-db"}, "ip": "10.244.2.12"},
    "dns":   {"ns": "kube-system", "labels": {"k8s-app": "kube-dns"}, "ip": "10.244.0.5"},
    "prom":  {"ns": "monitoring", "labels": {"app": "prometheus"}, "ip": "10.244.3.20"},
    "shell": {"ns": "monitoring", "labels": {"app": "debug-shell"}, "ip": "10.244.3.21"},
    "job":   {"ns": "reports", "labels": {"app": "report-job"}, "ip": "10.244.2.30"},
}
# namespace 的 label：kubernetes.io/metadata.name 由控制平面自動加上
NS_LABELS = {ns: {"kubernetes.io/metadata.name": ns} for ns in ["clinic", "kube-system", "monitoring", "reports"]}
EXTERNAL = {"informix": "10.20.5.31", "internet": "203.0.113.50"}


def matches(selector, labels):
    """matchLabels：selector 的每一組鍵值，labels 都要有而且相同；空的 selector 選到全部"""
    return all(labels.get(k) == v for k, v in selector.items())


def endpoint(name):
    if name in PODS:
        return {"name": name, "pod": True, **PODS[name]}
    return {"name": name, "pod": False, "ip": EXTERNAL[name]}


def policy_types(p):
    # 沒寫 policyTypes：一定有 Ingress；有 egress 規則才加上 Egress
    return p.get("policyTypes") or (["Ingress"] + (["Egress"] if "egress" in p else []))


def peer_matches(peer, policy_ns, other):
    if "ipBlock" in peer:                       # 叢集外的位址用 ipBlock
        if other["pod"]:
            return False
        ip = ipaddress.ip_address(other["ip"])
        block = peer["ipBlock"]
        return ip in ipaddress.ip_network(block["cidr"]) and not any(
            ip in ipaddress.ip_network(e) for e in block.get("except", []))
    if not other["pod"]:
        return False
    if "namespaceSelector" in peer:
        ns_ok = matches(peer["namespaceSelector"], NS_LABELS[other["ns"]])
    else:
        ns_ok = other["ns"] == policy_ns        # 只寫 podSelector：只看 policy 自己的 namespace
    pod_ok = matches(peer.get("podSelector", {}), other["labels"])
    return ns_ok and pod_ok                     # 同一個元素裡的兩個條件是 AND


def ports_match(rule, proto, port):
    ports = rule.get("ports")
    if not ports:                               # 沒寫 ports：全部的 port
        return True
    return any(p.get("protocol", "TCP") == proto and p.get("port") in (None, port) for p in ports)


def direction_allowed(direction, pod, other, proto, port, policies):
    """pod 是被這個方向管的那一端；回傳 (放行與否, 原因)"""
    selecting = [p for p in policies
                 if p["ns"] == pod["ns"] and matches(p["podSelector"], pod["labels"])
                 and direction in policy_types(p)]
    if not selecting:
        return True, "沒有 policy 選到"
    key, side = ("ingress", "from") if direction == "Ingress" else ("egress", "to")
    for p in selecting:
        for i, rule in enumerate(p.get(key, []), 1):
            peers = rule.get(side)
            peer_ok = not peers or any(peer_matches(x, p["ns"], other) for x in peers)   # 元素之間是 OR
            if peer_ok and ports_match(rule, proto, port):
                return True, f"{p['name']} 第 {i} 條"
    return False, "被 " + "、".join(p["name"] for p in selecting) + " 選到，沒有規則放行"


def check(src, dst, port, policies, proto="TCP"):
    s, d = endpoint(src), endpoint(dst)
    out_ok, out_why = direction_allowed("Egress", s, d, proto, port, policies) if s["pod"] else (True, "叢集外")
    in_ok, in_why = direction_allowed("Ingress", d, s, proto, port, policies) if d["pod"] else (True, "叢集外")
    mark = "放行" if out_ok and in_ok else "擋下"
    print(f"  {src:>5} → {dst:<8} {proto}/{port:<5} {mark}  出：{out_why}；進：{in_why}")


DEFAULT_DENY = {"name": "default-deny", "ns": "clinic", "podSelector": {}, "policyTypes": ["Ingress", "Egress"]}
API_TO_DB = {"name": "api-egress", "ns": "clinic", "podSelector": {"app": "clinic-api"}, "policyTypes": ["Egress"],
             "egress": [{"to": [{"podSelector": {"app": "clinic-db"}}], "ports": [{"port": 5432}]}]}
DB_FROM_API = {"name": "db-ingress", "ns": "clinic", "podSelector": {"app": "clinic-db"}, "policyTypes": ["Ingress"],
               "ingress": [{"from": [{"podSelector": {"app": "clinic-api"}}], "ports": [{"port": 5432}]}]}
ALLOW_DNS = {"name": "allow-dns", "ns": "clinic", "podSelector": {}, "policyTypes": ["Egress"],
             "egress": [{"to": [{"namespaceSelector": {"kubernetes.io/metadata.name": "kube-system"},
                                 "podSelector": {"k8s-app": "kube-dns"}}],
                         "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]}]}
# 讓 monitoring 的 Prometheus 抓 api 的指標：同一個元素（AND）與分成兩個元素（OR）
SCRAPE_AND = {"name": "scrape-and", "ns": "clinic", "podSelector": {"app": "clinic-api"}, "policyTypes": ["Ingress"],
              "ingress": [{"from": [{"namespaceSelector": {"kubernetes.io/metadata.name": "monitoring"},
                                     "podSelector": {"app": "prometheus"}}], "ports": [{"port": 8000}]}]}
SCRAPE_OR = {"name": "scrape-or", "ns": "clinic", "podSelector": {"app": "clinic-api"}, "policyTypes": ["Ingress"],
             "ingress": [{"from": [{"namespaceSelector": {"kubernetes.io/metadata.name": "monitoring"}},
                                   {"podSelector": {"app": "prometheus"}}], "ports": [{"port": 8000}]}]}
API_TO_HIS = {"name": "api-to-his", "ns": "clinic", "podSelector": {"app": "clinic-api"}, "policyTypes": ["Egress"],
              "egress": [{"to": [{"ipBlock": {"cidr": "10.20.5.31/32"}}], "ports": [{"port": 9088}]}]}

print("① 沒有任何 policy：全部互通")
check("job", "db", 5432, [])
check("api", "internet", 443, [])

print("\n② 只加 default-deny：clinic 裡的 Pod 進出都擋")
check("api", "db", 5432, [DEFAULT_DENY])
check("job", "db", 5432, [DEFAULT_DENY])

print("\n③ 開了 api → db，忘了 DNS")
step3 = [DEFAULT_DENY, API_TO_DB, DB_FROM_API]
check("api", "db", 5432, step3)
check("api", "dns", 53, step3, proto="UDP")
check("web", "db", 5432, step3)

print("\n④ 補上 allow-dns")
step4 = step3 + [ALLOW_DNS]
check("api", "dns", 53, step4, proto="UDP")
check("api", "internet", 53, step4, proto="UDP")

print("\n⑤ namespaceSelector 與 podSelector：同一個元素（AND）")
check("prom", "api", 8000, step4 + [SCRAPE_AND])
check("shell", "api", 8000, step4 + [SCRAPE_AND])
print("   分成兩個元素（OR）")
check("shell", "api", 8000, step4 + [SCRAPE_OR])

print("\n⑥ api → 叢集外的 Informix")
check("api", "informix", 9088, step4)
check("api", "informix", 9088, step4 + [API_TO_HIS])
```

幾個要看的地方：

- ② 的 `job → db` 是「出」放行、「進」擋下：`reports` 沒有任何 policy，擋下它的是 `db` 這一端的 ingress。
- ③ 的 api 連得到 db 的 IP，但實際的程式要先查 DNS，那一行是擋下，使用者看到的是名稱解析失敗。
- ⑤ 的除錯 Pod 在 AND 寫法下被擋、在 OR 寫法下放行。
- ⑥ 只代表叢集這一側放行了，封包出了叢集還要過舊系統的防火牆。放行方式見 [Kubernetes 連到叢集外的舊系統](#/skill/k8s-egress)。

## CNI：誰執行 NetworkPolicy

NetworkPolicy 由網路外掛（CNI）執行，CNI 的角色見 [Kubernetes 網路](#/skill/k8s-networking)。常見的三個：

| CNI | 定位 | NetworkPolicy |
|---|---|---|
| Flannel | 最簡單的 overlay，只負責讓 Pod 互通 | 不實作。可以搭配 Calico 的政策引擎（即 Canal） |
| Calico | 用路由（可與院內路由器跑 BGP）或 overlay；政策功能完整，另有自己的 CRD 支援拒絕規則與優先順序 | 實作 |
| Cilium | 以 eBPF 為基礎，可以取代 kube-proxy，支援 L7 政策與流量觀測 | 實作 |

最後一欄是導入時最容易漏掉的事：NetworkPolicy 只是 API 裡的物件，由 CNI 負責執行。用的 CNI 不實作它時，`kubectl apply` 照樣成功、`kubectl get networkpolicy` 也列得出來，但流量完全不受影響，沒有任何錯誤訊息。所以選定 CNI 之後，要實際測一次（方法在「動手」）。

雲端代管（EKS、GKE、AKS 等）的 NetworkPolicy，有些要另外啟用或選特定的網路模式，以各服務文件為準。

## 常見錯誤與錯誤訊息

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| 套用 default deny 後，程式報 `Temporary failure in name resolution` 或 `could not translate host name` | egress 全擋，DNS 查詢送不出去 | 加 `allow-dns`：UDP 與 TCP 53，到 `kube-system` 的 DNS Pod |
| 寫了 NetworkPolicy，`kubectl get networkpolicy` 也列得出來，但流量完全不受影響 | CNI 不實作 NetworkPolicy；或 `podSelector` 的 label 打錯，什麼都沒選到 | 確認 CNI；`kubectl describe networkpolicy` 看它選了哪些 Pod，再用 `kubectl get pods -l <selector>` 對照 |
| 套用 default deny 後，網站經過 Ingress 回 504 或 502 | Ingress controller 連不進 web | 給 web 一條 ingress，`from` 寫 controller 的 namespace |
| 開了 web → api 的 80，還是逾時 | NetworkPolicy 比對的是容器的 port（8000） | port 改成容器的 port，或寫容器 port 的名稱 |
| 稽核發現 `monitoring` 裡任何 Pod 都連得到 api | `namespaceSelector` 與 `podSelector` 被寫成兩個元素（OR） | 合併成同一個元素（AND） |

排查時先分清楚是「被擋」還是「沒人在聽」：NetworkPolicy 與防火牆通常丟掉封包，用戶端看到的是逾時；連線被拒絕（connection refused）代表封包到了，但那個 port 上沒有程式。更完整的排查順序見 [Kubernetes 排錯](#/skill/k8s-troubleshooting)。

## 動手

1. 執行上面的模擬，自己加兩個情境：把 `ALLOW_DNS` 的 TCP 那一筆刪掉，測 `check("api", "dns", 53, …, proto="TCP")`；把 `DB_FROM_API` 的 `from` 改成 `[{"namespaceSelector": {}}]`（空的 selector 選到所有 namespace），看 `job → db` 的結果怎麼變（稽核那張單的情況）。先預測再執行。
2. 做本課的程式題：補一組 NetworkPolicy，讓 api 只連得到 db 的 5432 與 DNS；選做的 Python 題是實作評估器裡比對來源與 namespace 的那一段。
3. 到 [NetworkPolicy 實驗室](#/lab/NetworkPolicyLab) 加減 policy，播放「api 查 DNS」「可疑 Pod → db」「api → 舊系統」等連線，看每一條是哪一條規則決定的。
4. 在本機叢集驗證 CNI 有沒有執行 NetworkPolicy。叢集照 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建好（`clinic` namespace 裡已經跑著 clinic-api）。本機叢集工具的預設 CNI 不一定實作 NetworkPolicy，依工具與版本而定：

```bash
kubectl apply -f default-deny.yaml                     # 上面第一步那份（namespace: clinic）
kubectl run probe -n clinic --rm -it --image=busybox:1.36 -- nslookup kubernetes.default
# 預期：逾時（;; connection timed out; no servers could be reached）
# 如果還查得到：這個 CNI 沒有執行 NetworkPolicy，換成有實作的 CNI（例如 Calico 或 Cilium，安裝方式見各專案文件）再試
kubectl apply -f allow-dns.yaml
kubectl run probe -n clinic --rm -it --image=busybox:1.36 -- nslookup kubernetes.default
# 預期：查得到 kubernetes.default.svc.cluster.local（Address 是 Service 網段的第一個位址，例如 10.96.0.1）
kubectl delete -f allow-dns.yaml -f default-deny.yaml  # 做完刪掉，否則 clinic-api 之後建立的新連線都會被擋
```

Pod 連到院內舊系統時，對方看到的來源與防火牆要放行誰，接著讀 [Kubernetes 連到叢集外的舊系統](#/skill/k8s-egress)。
