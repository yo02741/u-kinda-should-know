## 搬上叢集的第一週，收到兩張單

門診掛號的 `clinic-api` 照實作路線第 10 階段的 manifest 搬上院內的 Kubernetes 叢集，放在 `clinic` namespace，旁邊有 `clinic-web` 與 PostgreSQL `clinic-db`。

第一張單是門診櫃台：掛號時查不到病患的基本資料。這段資料要查院內舊系統的 Informix，API 的 log 只有一行 `connect to 10.20.5.31:9088 failed: timed out after 10s`。防火牆丟掉的連線來自 10.20.30.11、10.20.30.12，是叢集的 worker 節點；舊系統只放行舊虛擬機的 10.20.8.15。

第二張單是資安稽核：別的 namespace 的測試 Pod 連上了 `clinic-db` 的 5432：

```bash
$ kubectl run probe -n reports --rm -it --image=busybox:1.36 -- nc -vz -w 3 clinic-db.clinic 5432
clinic-db.clinic (10.96.212.40:5432) open
```

原因是同一個網路模型：每個 Pod 有自己的 IP，叢集內預設全部互通；Pod 連出叢集時，來源多半被換成節點的 IP。

## Pod 網路：每個 Pod 一個 IP，預設全部互通

Kubernetes 對網路只訂了幾條要求，實作交給網路外掛（CNI）：

- 每個 Pod 有一個整個叢集內唯一的 IP，Pod 裡的容器共用它（所以同一個 Pod 的容器用 `localhost` 互連）。
- 任何 Pod 可以直接連到任何節點上的任何 Pod，中間**不經過 NAT**：對方看到的來源位址就是你的 Pod IP。
- 節點上的程式（例如 kubelet）連得到這個節點上的每個 Pod，探針就是這樣打進去的。

沒有任何設定時，`reports` namespace 的 Pod 連得到 `clinic` 的資料庫，稽核那張單就是這樣來的。

```text
節點 10.20.30.11（Pod 網段 10.244.1.0/24）      節點 10.20.30.12（Pod 網段 10.244.2.0/24）
  clinic-web   10.244.1.10                        clinic-db    10.244.2.12   （clinic）
  clinic-api   10.244.1.11  ◄──── CNI 轉送 ────►  report-job   10.244.2.30   （reports）

Pod 之間的連線不做 NAT：clinic-db 看到的來源就是 10.244.1.11 或 10.244.2.30
```

## Service：固定的名字與 ClusterIP，背後是 EndpointSlice 與 kube-proxy

Pod 的 IP 每次重建都會變，服務之間用 Service 互連。`clinic-api` 連資料庫時寫 `clinic-db:5432`，這個名字對到一個 Service，它有固定的 ClusterIP（稽核輸出裡的 10.96.212.40）。這個 IP 是虛擬的，封包能送到 Pod 靠三個元件：

1. **EndpointSlice controller**：依 Service 的 selector 找出 Pod，把它們的 IP、port 與是否 ready 寫進 EndpointSlice 物件。
2. **kube-proxy**：在每個節點上監看 Service 與 EndpointSlice，把「連到 10.96.212.40:5432 的封包，改寫成某個 ready 的後端 Pod 的 IP 與 targetPort」寫成節點的封包轉送規則（目的位址轉換，DNAT）。
3. **CNI**：把改寫後的封包送到那個 Pod 所在的節點。

```bash
$ kubectl get endpointslices -n clinic -l kubernetes.io/service-name=clinic-db
NAME              ADDRESSTYPE   PORTS   ENDPOINTS     AGE
clinic-db-7xk2p   IPv4          5432    10.244.2.12   9d
```

叢集的 DNS 替每個 Service 建一筆紀錄。同 namespace 寫 `clinic-db` 就好，跨 namespace 寫 `clinic-db.clinic`，完整名稱是 `clinic-db.clinic.svc.cluster.local`（`<service>.<namespace>.svc.cluster.local`）。

## 叢集內連不到時先看什麼

| 現象 | 代表 |
|---|---|
| `kubectl get endpointslices` 的 ENDPOINTS 是空的 | Service 的 selector 選不到 Pod，或 Pod 沒有 ready |
| 用戶端逾時（timed out） | 封包被丟掉：NetworkPolicy 或防火牆 |
| 連線被拒絕（connection refused） | 封包到了，但那個 port 上沒有程式 |

:::stop 讀到這裡可以先停：會從另一個 Pod 用 `<svc>.<ns>.svc.cluster.local` 連到服務，並用 `kubectl get endpointslices` 分辨是 selector 選不到 Pod 還是封包被擋。後面的 CNI 與網段、Service 的類型與 DNS 細節、從院內連進叢集，在要建叢集或對院內開放服務時再回來讀。

## CNI：誰負責讓 Pod 互通

把 Pod 接上網路、分配 IP、讓不同節點上的 Pod 互通的是 CNI 外掛（Container Network Interface）。kubeadm 這類工具不會替你裝，發行版則各有預設（例如 RKE2 預設是 Canal，也就是 Flannel 加上 Calico 的政策引擎）。常見的 CNI 與它們實不實作 NetworkPolicy，見 [Kubernetes NetworkPolicy](#/skill/k8s-network-policy)。

建叢集前還要決定兩段位址：Pod 網段（例如 10.244.0.0/16）與 Service 網段（kubeadm 預設 10.96.0.0/12）。這兩段不能和院內任何既有網段重疊，否則 Pod 連到那段院內位址時，封包會被當成叢集內部流量而送不出去。這要先和網路組核對，見 [導入 Kubernetes 前要準備什麼](#/skill/k8s-readiness)。

## Service 的類型、版本與叢集內的 DNS

| 項目 | 版本狀態 |
|---|---|
| EndpointSlice | Kubernetes 1.21 成為正式版 |
| 舊的 Endpoints API | 1.33 被標為棄用，直接讀它的腳本會收到警告；排查時改用 `kubectl get endpointslices` |
| kube-proxy 的 iptables 模式 | Linux 上的預設 |
| kube-proxy 的 nftables 模式 | 1.33 成為正式版（需要較新的核心） |
| kube-proxy 的 IPVS 模式 | 1.35 被標為棄用 |

Cilium 這類 CNI 也可以完全取代 kube-proxy。叢集用哪一種是建置時的決定，應用程式這一側看不出差別。

### 四種類型

| `type` | 做什麼 | 用在哪 |
|---|---|---|
| `ClusterIP`（預設） | 配一個叢集內的虛擬 IP | 服務之間互相呼叫；Ingress 與 Gateway 的後端 |
| `NodePort` | 在每個節點開同一個 port（預設範圍 30000–32767），轉到 ClusterIP | 讓院內既有的負載平衡設備接進來；測試 |
| `LoadBalancer` | 在 NodePort 之上，再向「某個元件」要一個對外的 IP | 雲端自動建立負載平衡器；地端要有 MetalLB 這類元件 |
| `ExternalName` | 不配 IP，DNS 直接回一筆 CNAME 指向外部名稱 | 給叢集外、有 DNS 名稱的系統一個叢集內的名字 |

另外還有 `clusterIP: None` 的 headless Service：不配虛擬 IP，DNS 直接回每個 Pod 的 IP，StatefulSet 用它給每個副本固定的名字（見 [Kubernetes 有狀態服務](#/skill/k8s-statefulset)）。

### 叢集內的 DNS

叢集的 DNS 多半是 CoreDNS，跑在 `kube-system`，前面有一個叫 `kube-dns` 的 Service。`cluster.local` 是預設的叢集網域，可以在建叢集時改。

Pod 的 `/etc/resolv.conf` 由 kubelet 產生，搜尋清單裡有自己的 namespace。預設的 `ndots:5` 會讓 `his-db.example.org` 這種點數少於 5 的外部名稱先依序套上搜尋清單查一輪，每次解析多出幾次查詢；在名稱最後加一個點（`his-db.example.org.`）或調整 Pod 的 `dnsConfig` 可以避開。

每個用名稱連線的 Pod，第一步都是連到 `kube-system` 的 DNS Pod 的 UDP 53（回應太大時改用 TCP 53），寫 NetworkPolicy 時要放行。

## 從院內連進叢集：地端沒有雲端的負載平衡器

院內的使用者要連到 `clinic-web`，流量要從叢集外進來。在雲端，`type: LoadBalancer` 會自動建立一個雲端負載平衡器；地端叢集沒有對應的元件，`EXTERNAL-IP` 會一直停在 `<pending>`（[導入 Kubernetes 前要準備什麼](#/skill/k8s-readiness) 有實際輸出）。補上它有兩條路。

**MetalLB**：在叢集裡跑的元件，從一段預先保留的院內 IP 中分配位址給 LoadBalancer 型的 Service，再用 L2 或 BGP 對院內網路宣告「這個 IP 在這裡」。那段 IP 要和網路組協調，不能和 DHCP 或其他設備撞到。

| | L2 模式 | BGP 模式 |
|---|---|---|
| 怎麼宣告 | 由一個節點回應這個 IP 的 ARP | 每個節點和院內路由器建立 BGP 連線，宣告這個 IP |
| 流量 | 某個 Service IP 的流量全部先進到同一個節點，再由 kube-proxy 分到各 Pod | 路由器用 ECMP 把流量分到多個節點 |
| 那個節點故障 | 改由另一個節點接手宣告，中間有短暫中斷 | 路由器移除那條路徑；雜湊重新分配時，部分既有連線可能被重設 |
| 對網路的要求 | 節點與用戶端在同一個 L2 網段就能用，不需要改路由器 | 路由器要支援 BGP 與 ECMP，網路組要配合設定 |

L2 模式提供的是容錯切換，單一 IP 的頻寬上限是一個節點的網卡；要讓流量分散到多個節點，用 BGP 模式。

**院內既有的負載平衡設備接 NodePort**：Service 用 `NodePort`，在院內的負載平衡設備上建一個 pool，成員是每個節點的 IP 加上那個 NodePort，並設定健康檢查。好處是沿用網路組熟悉的設備與憑證管理；代價是節點增減時要去改 pool。

不管哪一條路，都要決定 `externalTrafficPolicy`。預設的 `Cluster` 讓任何節點都能收流量再轉給別的節點上的 Pod，但轉送時會做來源位址轉換，Pod 看到的來源會變成節點的 IP。改成 `Local` 時只有本身跑著這個服務 Pod 的節點會接流量，保留使用者的來源 IP，負載平衡設備的健康檢查要能分辨哪些節點沒有 Pod。

### Ingress 與 Gateway API

對外通常只開一個入口：Ingress controller（或 Gateway API 的實作）用一個 LoadBalancer 或 NodePort 對外，再依 Host 與路徑把 HTTP 流量分給各個 ClusterIP Service，TLS 也在這一層終止。寫法與 Gateway API 的分層見 [Kubernetes 實作：把服務寫成 manifest](#/skill/k8s-manifests)。Kubernetes 社群維護的 ingress-nginx 已在 2026 年 3 月停止維護，之後沒有新版本與安全修補，新的建置要選其他 controller 或 Gateway API 的實作。

## 雲端代管的差異

| 項目 | 地端自建 | 雲端代管（EKS、GKE、AKS 等） |
|---|---|---|
| `type: LoadBalancer` | MetalLB，或院內設備接 NodePort | 自動建立雲端負載平衡器 |
| Pod 的 IP | CNI 自己的網段，出叢集多半 SNAT 成節點 IP | 有些服務讓 Pod 直接拿虛擬網路裡的 IP |

## 常見錯誤與錯誤訊息

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| `kubectl get endpointslices` 的 ENDPOINTS 是空的，連 Service 沒有回應 | Service 的 selector 選不到 Pod，或 Pod 沒有 ready | 對照 Service 的 selector 與 Pod 的 label；Pod 沒有 ready 就查探針 |
| `EXTERNAL-IP` 一直是 `<pending>` | 叢集沒有實作 LoadBalancer 的元件 | 裝 MetalLB，或改用 NodePort 接院內的負載平衡設備 |
| 院內使用者經 LoadBalancer 或 NodePort 連進來，Pod 看到的來源都是節點的 IP | `externalTrafficPolicy` 是預設的 `Cluster`，轉送時做了來源位址轉換 | 改成 `Local`，負載平衡設備的健康檢查要能分辨哪些節點沒有 Pod |
| Pod 連不到某一段院內位址，其他位址正常 | Pod 網段或 Service 網段和那段院內網段重疊，封包被當成叢集內部流量 | 建叢集前和網路組核對兩段位址 |
| 讀 Endpoints API 的腳本收到棄用警告 | 舊的 Endpoints API 在 1.33 被標為棄用 | 改用 `kubectl get endpointslices` |
| 解析 `his-db.example.org` 這種外部名稱特別慢 | `ndots:5` 讓點數少於 5 的名稱先套搜尋清單查一輪 | 名稱最後加一個點，或調整 Pod 的 `dnsConfig` |

更完整的排查順序見 [Kubernetes 排錯](#/skill/k8s-troubleshooting)。

## 動手

1. 本機叢集照 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建好，從另一個 Pod 用 `<svc>.<ns>.svc.cluster.local` 連到 api，對照 `kubectl get endpointslices` 列出的 Pod 位址。
2. 把 Service 的 selector 故意改錯一次，記下 ENDPOINTS 變空與連線失敗的樣子，再改回來。
3. 建一個 `type: LoadBalancer` 的 Service，看 `EXTERNAL-IP` 的狀態，寫下這座叢集由哪個元件配發位址；沒有元件時改用 NodePort 連一次。

收緊叢集內的連線，接著讀 [Kubernetes NetworkPolicy](#/skill/k8s-network-policy)；Pod 要連院內的舊系統，讀 [Kubernetes 連到叢集外的舊系統](#/skill/k8s-egress)。
