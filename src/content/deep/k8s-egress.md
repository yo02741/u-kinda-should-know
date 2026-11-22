## 掛號時查不到病患資料：舊系統的防火牆丟掉了連線

門診掛號的 `clinic-api` 搬上院內的 Kubernetes 叢集，放在 `clinic` namespace。門診櫃台開了一張單：掛號時查不到病患的基本資料。這段資料要查院內舊系統的 Informix，API 的 log 只有一行：

```text
2026-11-09 09:12:41 ERROR his: connect to 10.20.5.31:9088 failed: timed out after 10s
```

防火牆丟掉的連線來自 10.20.30.11、10.20.30.12，是叢集的 worker 節點；舊系統只放行舊虛擬機的 10.20.8.15。這一課接在 [Kubernetes 網路](#/skill/k8s-networking) 之後。

## 為什麼舊系統看到的是節點的 IP

叢集內的 Pod 之間不做 NAT（見 [Kubernetes 網路](#/skill/k8s-networking)）。Pod 連到叢集外的位址時就不一樣了：Pod 網段是叢集自己的位址，院內的路由器不知道 10.244.1.11 在哪裡，回應送不回來。所以多數 CNI 預設在封包離開節點時做來源位址轉換（SNAT，也叫 masquerade），把來源改成節點的 IP：

```text
clinic-api（Pod 10.244.1.11，在節點 10.20.30.11 上）
   │  src 10.244.1.11  →  dst 10.20.5.31:9088
   ▼
節點 10.20.30.11：離開叢集，SNAT
   │  src 10.20.30.11  →  dst 10.20.5.31:9088
   ▼
舊系統防火牆：只放行 10.20.8.15  →  丟掉封包（用戶端看到逾時，不是連線被拒絕）
```

API 的 Pod 被排到哪個節點，來源就是哪個節點的 IP。今天在 10.20.30.11，重啟後可能到 10.20.30.13。防火牆紀錄裡出現兩個節點的位址，是因為兩個副本分別在兩個節點上。

例外是 CNI 用 BGP 把 Pod 網段直接發布給院內路由器、並關掉 SNAT 的架構：這時舊系統看到的是 Pod IP，但 Pod IP 每次重建都會變，防火牆一樣跟不上。

## 防火牆要放行誰

| 做法 | 防火牆規則 | 節點增減時 | 要注意的事 |
|---|---|---|---|
| 放行每一台 worker 節點的 IP | 逐台列出 | 每次都要申請變更；漏了就會出現「有時候連得到」 | 節點上的任何 Pod 都在放行範圍內 |
| 節點放在專用網段，放行整段 | 一條 CIDR | 新節點用同一段位址就不必改 | 範圍更大，叢集內要用 NetworkPolicy 限縮哪些 Pod 能連 |
| 專用節點（taint 加 nodeSelector），只放行這幾台 | 少數幾台 | 只有這組節點變動時要改 | 需要連舊系統的服務只能排到這幾台，容量要另外規劃 |
| egress gateway：指定的 Pod 從固定的出口 IP 出去 | 一個或一組出口 IP | 不受 worker 增減影響 | 要 CNI 支援；出口節點本身要做高可用 |

egress gateway 是部分 CNI 或平台提供的功能，例如 Cilium 的 Egress Gateway、Antrea 的 Egress、OpenShift 的 EgressIP；Calico 的 egress gateway 屬於商業版本。可用的版本、授權與高可用的做法以各專案文件為準。

不論選哪一種，防火牆與 NetworkPolicy 管的是兩件事：防火牆決定院內網路上「哪些 IP」能連 Informix；NetworkPolicy 決定叢集裡「哪些 Pod」能從那些 IP 出去。只做前者時，放行了節點的 IP，同一個節點上的任何 Pod（包括別的 namespace 的測試 Pod）也連得到 Informix。

所以 `clinic` 維持 default deny（寫法見 [Kubernetes NetworkPolicy](#/skill/k8s-network-policy)），只給 `clinic-api` 加一條 egress。別的 namespace 要有自己的 default deny egress，`clinic` 的 policy 管不到它們；叢集管理者通常在建立 namespace 時一起建立，或用 CNI 提供的叢集層級政策。給 `clinic-api` 的那一條：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-to-his
  namespace: clinic
spec:
  podSelector:
    matchLabels:
      app: clinic-api
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.20.5.31/32        # 叢集外的位址用 ipBlock
      ports:
        - protocol: TCP
          port: 9088
```

申請防火牆規則時，來源寫節點網段（或出口 IP）、目的寫 10.20.5.31、port 寫 TCP 9088，並附上叢集內用 NetworkPolicy 限制哪些服務能用這條路的說明。申請單的寫法見 [網路通不通：從 DNS 到防火牆](#/skill/network-troubleshooting)。

:::stop 讀到這裡可以先停：會說出舊系統的防火牆看到的來源是哪個 IP，並寫出給網路組的放行申請：來源是節點網段、專用節點還是 egress gateway 的出口 IP，節點增減時由誰更新。後面的無 selector 的 Service、ExternalName 與院內 CA 的憑證，在要給舊系統一個叢集內的名字，或要連它的 HTTPS API 時再讀。

## 給叢集外的系統一個叢集內的名字

程式裡寫死 `10.20.5.31`，Informix 換主機時每個服務都要改設定。可以在叢集裡建一個沒有 selector 的 Service，再自己寫 EndpointSlice 指向外部位址：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: his-db
  namespace: clinic
spec:                        # 沒有 selector：controller 不會替它產生 EndpointSlice
  ports:
    - name: informix
      protocol: TCP
      port: 9088
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: his-db-1
  namespace: clinic
  labels:
    kubernetes.io/service-name: his-db                    # 對到上面的 Service
    endpointslice.kubernetes.io/managed-by: cluster-admins  # 標明這份是人管的，不是 controller
addressType: IPv4
ports:
  - name: informix           # 要和 Service 的 port 名稱相同
    protocol: TCP
    port: 9088
endpoints:
  - addresses:
      - "10.20.5.31"
```

程式改連 `his-db.clinic:9088`，舊系統搬家時只改這份 EndpointSlice。kube-proxy 會把 ClusterIP 改寫成 10.20.5.31，多數 CNI 在這個改寫之後才比對 NetworkPolicy，所以上面那條 `ipBlock` 要寫 Informix 的實際 IP。

舊系統本來就有 DNS 名稱時，可以用 `ExternalName`：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: his-api
  namespace: clinic
spec:
  type: ExternalName
  externalName: his-api.example.org     # 叢集 DNS 對 his-api.clinic 回一筆 CNAME
```

它只是一筆 DNS 的 CNAME，沒有虛擬 IP、也沒有 port 對應。用在 HTTPS 時要小心：程式連的是 `https://his-api`，TLS 的 SNI 與 HTTP 的 Host 標頭都會帶 `his-api`，對方的憑證上只有 `his-api.example.org`，驗證會失敗。HTTPS 的服務直接用對方的正式名稱連線，比繞一層 ExternalName 單純。

| | 無 selector 的 Service 加 EndpointSlice | ExternalName |
|---|---|---|
| 指向 | IP 位址 | DNS 名稱 |
| 有沒有 ClusterIP 與 port 對應 | 有 | 沒有，只是 CNAME |
| 對方換位址時 | 改 EndpointSlice | 對方改自己的 DNS 就好 |
| HTTPS | 憑證要涵蓋程式使用的名稱 | 憑證通常對不上叢集內的名稱 |

## 院內 CA 簽的憑證

舊系統另有一個 HTTPS 的查詢 API，憑證由院內 CA 簽發。院內電腦透過網域派送了根憑證，但容器不會繼承節點或網域電腦的信任清單：

```text
requests.exceptions.SSLError: HTTPSConnectionPool(host='his-api.example.org', port=443): Max retries exceeded ...
(Caused by SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate (_ssl.c:1006)')))
```

兩種做法：建 image 時把根憑證裝進去（Dockerfile 的寫法見 [HTTPS 憑證](#/skill/https-certificates)），或在執行時從 ConfigMap 掛進來，再用環境變數告訴程式去哪裡找：

```yaml
      containers:
        - name: api
          env:
            - name: SSL_CERT_FILE              # Python 的 ssl 模組（OpenSSL）讀這個
              value: /etc/hospital-ca/ca-bundle.crt
            - name: REQUESTS_CA_BUNDLE         # requests 預設用 certifi 內附的清單，要另外指定
              value: /etc/hospital-ca/ca-bundle.crt
          volumeMounts:
            - name: hospital-ca
              mountPath: /etc/hospital-ca
              readOnly: true
      volumes:
        - name: hospital-ca
          configMap:
            name: hospital-ca-bundle           # 院內根憑證加上公開 CA 的完整清單
```

這個檔案要包含公開 CA 加上院內 CA 的完整清單；只放院內根憑證時，程式改用這個檔案後就不再信任公開網站。拉 image 的信任設定在節點上，和這裡是兩件事（見 [導入 Kubernetes 前要準備什麼](#/skill/k8s-readiness)）。namespace 多了以後，cert-manager 專案的 trust-manager 可以把同一份 CA 清單同步到各個 namespace。

## 雲端代管的差異

| 項目 | 地端自建 | 雲端代管（EKS、GKE、AKS 等） |
|---|---|---|
| 固定的出口 IP | 節點網段、專用節點或 egress gateway | 雲端的 NAT 閘道之類的服務 |
| 連院內舊系統 | 同一個院內網路，主要是防火牆 | 還要先有專線或 VPN，見 [地端、雲端還是混合雲](#/skill/hosting-models) |

## 常見錯誤與錯誤訊息

| 訊息或現象 | 原因 | 處理 |
|---|---|---|
| Pod 連叢集外的系統 `connection timed out`，從節點上 `nc -vz` 也逾時 | 對方防火牆擋掉節點的 IP | 依前面的表選放行方式，向網路組申請 |
| 同樣的連線，從節點上通、從 Pod 裡逾時 | 叢集內的 egress policy 擋住，或 CNI 的 SNAT 設定與預期不同 | 檢查這個 Pod 的 egress 規則；查 CNI 的 masquerade 設定 |
| 加了新節點後，部分請求連舊系統逾時 | 新節點的 IP 不在防火牆規則裡，排到新節點的 Pod 才會失敗 | 節點改用固定網段，或把加節點的流程加上防火牆變更 |
| `CERTIFICATE_VERIFY_FAILED`、`unable to get local issuer certificate` | 容器不信任院內 CA | 把根憑證裝進 image，或掛載 CA 清單並設定 `SSL_CERT_FILE` 與 `REQUESTS_CA_BUNDLE` |
| 經過 ExternalName 連 HTTPS，出現 `Hostname mismatch` | 憑證上沒有程式使用的名稱 | 直接連對方的正式名稱 |

防火牆通常丟掉封包，用戶端看到的是逾時；連線被拒絕（connection refused）代表封包到了，但那個 port 上沒有程式。更完整的排查順序見 [Kubernetes 排錯](#/skill/k8s-troubleshooting)。

## 動手

1. 在本機叢集上看 SNAT。叢集照 [clinic-api 的本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md) 建好，在本機用 `python3 -m http.server 9000` 起一個伺服器，從 Pod 連過去（`wget -qO- http://<本機位址>:9000/`；kind 的本機位址可以用 `docker network inspect kind` 找閘道）。伺服器的 log 印出的來源位址是節點的位址，拿去和 `kubectl get pod -o wide` 列出的 Pod IP 對照。
2. 到 [NetworkPolicy 實驗室](#/lab/NetworkPolicyLab) 播放「api → 舊系統」這條連線，看叢集這一側是哪一條規則放行；再寫下封包出了叢集之後還要過哪一道防火牆。
3. 寫一份給網路組的放行申請：來源是節點網段、專用節點還是 egress gateway 的哪個 IP，目的與 port，節點增減時由誰更新規則；附上第 1 步對方 log 印出的來源位址。

叢集裡的權限與 namespace 怎麼分給各團隊，接著讀 [Kubernetes 權限](#/skill/k8s-rbac-tenancy) 與 [Kubernetes 多租戶](#/skill/k8s-multi-tenancy)。
