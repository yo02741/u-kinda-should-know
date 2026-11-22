// 題庫：P11 新課（n1 批）：k8s-networking、k8s-network-policy、k8s-egress
export default [
  {
    skill: 'k8s-networking',
    questions: [
      {
        q: '叢集內連到 ClusterIP 10.96.212.40:5432 的封包，是怎麼送到 `clinic-db` 的 Pod 的？',
        options: [
          'ClusterIP 綁在 clinic-db 的 Pod 上；Pod 重建時，CNI 會把同一個 IP 移到新的 Pod 上面',
          'kube-proxy 在節點上把目的改寫成 EndpointSlice 裡某個 ready 的 Pod IP 與 targetPort，再由 CNI 送到',
          '叢集的 DNS 把 Service 名稱直接解析成 Pod IP，ClusterIP 只有叢集外的用戶端連進來時才會用到',
          'EndpointSlice controller 收下每一個封包，依 selector 挑出一個 Pod 之後，再把封包轉送過去給它',
        ],
        answer: 1,
        explain: 'ClusterIP 是虛擬的。EndpointSlice controller 只負責把 selector 選到的 Pod 位址與是否 ready 寫進 EndpointSlice，不經手封包；kube-proxy 在每個節點把連到 ClusterIP 的封包改寫成某個 ready 的 Pod IP 與 targetPort（DNAT）；CNI 把改寫後的封包送到那個 Pod 所在的節點。DNS 回的是 ClusterIP，不是 Pod IP（headless Service 才直接回 Pod IP）。',
      },
      {
        q: '`reports` namespace 的 Pod 連 `clinic-db.clinic:5432`，用戶端等到逾時。Service 的 EndpointSlice 如下，最可能的原因是什麼？',
        code: '$ kubectl get endpointslices -n clinic -l kubernetes.io/service-name=clinic-db\nNAME              ADDRESSTYPE   PORTS   ENDPOINTS     AGE\nclinic-db-7xk2p   IPv4          5432    10.244.2.12   9d',
        lang: 'bash',
        options: [
          'Service 的 selector 選不到 Pod，或 Pod 沒有 ready',
          '封包被丟掉：NetworkPolicy 或防火牆擋住了這條連線',
          'PostgreSQL 沒有在 5432 上監聽，封包到了但沒有程式接',
          '跨 namespace 要寫完整的 `clinic-db.clinic.svc.cluster.local` 才解析得到',
        ],
        answer: 1,
        explain: 'ENDPOINTS 有位址，代表 selector 選到了 Pod、Pod 也 ready，可以先排除 Service。逾時代表封包被丟掉，方向是 NetworkPolicy 或防火牆；那個 port 上沒有程式時，用戶端看到的是連線被拒絕（connection refused），不是逾時。跨 namespace 寫 `<svc>.<ns>` 就解析得到，完整名稱不是必要的。',
      },
      {
        q: '院內叢集的 `clinic-web` 用 `type: LoadBalancer`，`EXTERNAL-IP` 一直停在 `<pending>`。網路組不打算在路由器上設定 BGP。哪個做法可行？',
        options: [
          '裝 MetalLB 用 L2 模式：從和網路組協調好的保留 IP 配發位址，由一個節點回應這個 IP 的 ARP',
          '把 Service 改成 ClusterIP：ClusterIP 是固定不變的位址，院內使用者的電腦可以直接連到它',
          '繼續等：kube-proxy 會從節點所在的網段挑一個沒人用的 IP，過一陣子就會配給這個 Service',
          '裝 MetalLB 用 BGP 模式：它不需要網路組在路由器上做任何設定，流量還會自動分散到每一個節點',
        ],
        answer: 0,
        explain: '地端沒有配發位址的元件時，`EXTERNAL-IP` 會一直是 pending，等不會有結果。MetalLB 的 L2 模式只要節點與用戶端在同一個 L2 網段，不需要改路由器；它提供的是容錯切換，某個 IP 的流量先進到同一個節點。BGP 模式要路由器支援 BGP 與 ECMP、網路組配合設定。ClusterIP 是叢集內的虛擬位址，院內的電腦連不到。另一條可行的路是院內既有的負載平衡設備接 NodePort。',
      },
    ],
  },
  {
    skill: 'k8s-network-policy',
    questions: [
      {
        q: '`clinic` namespace 套用了「default deny（Ingress 與 Egress）」與「api 到 db 的 5432」兩組 NetworkPolicy 之後，`clinic-api` 開始印出 `could not translate host name "clinic-db" to address`。最可能的原因是什麼？',
        options: [
          'db 的 ingress 規則沒有放行 api，PostgreSQL 拒絕了這條連線',
          'egress 全擋之後沒有放行 DNS，名稱查詢送不到 kube-system 的 DNS Pod',
          'NetworkPolicy 套用後會移除 Service 的 DNS 紀錄，要改用 Pod IP 連線',
          'CNI 不實作 NetworkPolicy，套用時把 Pod 的 DNS 設定重置了',
        ],
        answer: 1,
        explain: '錯誤發生在解析名稱這一步，連線根本還沒開始。default deny 的 Egress 讓 api 連 kube-system 的 DNS Pod（UDP 與 TCP 53）也被擋下，所以 default deny 之後第一條要開 DNS。db 的 ingress 沒開的話，名稱解析得到、連線會逾時；NetworkPolicy 不會動 DNS 紀錄；CNI 不實作 NetworkPolicy 時規則沒有效果，也就不會出現這個錯誤。',
      },
      {
        q: '下面這份 NetworkPolicy 建在 `clinic` namespace。哪些 Pod 能連到 `clinic-api` 的 8000？',
        code: 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: api-scrape\n  namespace: clinic\nspec:\n  podSelector:\n    matchLabels:\n      app: clinic-api\n  policyTypes: [Ingress]\n  ingress:\n    - from:\n        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: monitoring\n        - podSelector:\n            matchLabels:\n              app: prometheus\n      ports:\n        - protocol: TCP\n          port: 8000',
        lang: 'yaml',
        options: [
          '只有 monitoring namespace 裡、label 是 app: prometheus 的 Pod',
          '任何 namespace 裡 label 是 app: prometheus 的 Pod，加上 monitoring 裡的所有 Pod',
          'monitoring 裡的所有 Pod，加上 clinic 裡 label 是 app: prometheus 的 Pod',
          '沒有任何 Pod，因為一個 Pod 不可能同時符合兩個條件',
        ],
        answer: 2,
        explain: '`from` 底下有兩個元素（兩個 `-`），彼此是 OR。第一個只有 namespaceSelector，選到 monitoring 裡的每一個 Pod；第二個只有 podSelector，範圍是 policy 自己的 namespace（clinic），不是所有 namespace。要「只有 monitoring 裡的 Prometheus」，兩個條件要寫在同一個元素裡（AND）。',
      },
      {
        q: '叢集的 CNI 只裝了 Flannel。資安組在 `clinic` 套用了 default deny（Ingress 與 Egress），`kubectl get networkpolicy` 也列得出來，但 `reports` 的 Pod 還是連得到 `clinic-db`。原因是什麼？',
        options: [
          'default deny 要等 Pod 重建之後才會生效，套用之前就在跑的 Pod 不受影響',
          'NetworkPolicy 只擋得了同一個 namespace 的來源，跨 namespace 的連線它管不到',
          '空的 podSelector 什麼都選不到，要逐一列出 clinic 裡每個 Pod 的 label 才行',
          'NetworkPolicy 由 CNI 執行，Flannel 不實作它；套用會成功，流量卻不受影響',
        ],
        answer: 3,
        explain: 'NetworkPolicy 只是 API 裡的物件，由 CNI 負責執行。CNI 不實作時，`kubectl apply` 照樣成功、也列得出來，但沒有任何效果，也沒有錯誤訊息；Flannel 要搭配 Calico 的政策引擎（Canal），或換成 Calico、Cilium。空的 podSelector 選到 namespace 裡的每一個 Pod；被選到的 Pod，ingress 變成白名單之後，別的 namespace 的來源一樣進不來。',
      },
    ],
  },
  {
    skill: 'k8s-egress',
    questions: [
      {
        q: '`clinic-api` 連院內 Informix 逾時，舊系統的防火牆只放行舊主機的 IP。叢集有三台 worker 節點，明年還會加節點。網路組問來源要放行什麼，哪個做法最合適？',
        options: [
          '節點用固定網段並放行整段（或用 egress gateway 的出口 IP），叢集內再用 NetworkPolicy 限定只有 clinic-api 能連',
          '放行 Pod 網段 10.244.0.0/16：Pod 之間不做 NAT，送到 Informix 的封包來源就是 Pod IP',
          '放行 clinic-api 這個 Service 的 ClusterIP：Service 的位址固定，Pod 重建也不會改變',
          '逐台放行目前三台節點的 IP；之後新加入的節點會沿用叢集既有的規則，不必再申請',
        ],
        answer: 0,
        explain: 'Pod 連出叢集時，多數 CNI 會把來源 SNAT 成所在節點的 IP，所以防火牆看到的是節點；用固定網段或 egress gateway 才不會每加一台節點就要改規則。只放行節點時，同一節點上的任何 Pod 都連得到，所以叢集內要再用 NetworkPolicy 限縮。「Pod 之間不做 NAT」只適用於叢集內；ClusterIP 是叢集內的虛擬位址，不是連出去的來源；新節點的 IP 不會自動出現在院內防火牆上。',
      },
      {
        q: '程式用 HTTPS 連 `his-api` 這個名稱（下面的 Service），TLS 驗證失敗。原因是什麼？',
        code: 'apiVersion: v1\nkind: Service\nmetadata:\n  name: his-api\n  namespace: clinic\nspec:\n  type: ExternalName\n  externalName: his-api.example.org',
        lang: 'yaml',
        options: [
          'ExternalName 沒有對應 443 這個 port，要在 `spec.ports` 補上之後 TLS 才連得起來',
          'kube-proxy 把封包轉到 his-api.example.org 時做了 SNAT，對方因此拒絕 TLS 交握',
          'ExternalName 只是 CNAME：SNI 與 Host 帶的是 `his-api`，對方憑證上只有正式名稱',
          '叢集的 DNS 不解析叢集外的名稱，his-api.example.org 要先加進 CoreDNS 的設定',
        ],
        answer: 2,
        explain: 'ExternalName 只讓叢集 DNS 對 `his-api.clinic` 回一筆 CNAME，沒有虛擬 IP、也沒有 port 對應，kube-proxy 不經手。程式連的名稱是 `his-api`，TLS 的 SNI 與 HTTP 的 Host 標頭都帶 `his-api`，對方的憑證上只有 `his-api.example.org`，驗證失敗。HTTPS 的服務直接用對方的正式名稱連線比較單純。',
      },
      {
        q: '`clinic` 是 default deny。`clinic-api` 透過無 selector 的 Service `his-db` 連院內 Informix（10.20.5.31:9088），要替 api 開一條 egress。規則的目的要怎麼寫？',
        options: [
          '`podSelector` 選 `his-db`：這個 Service 在 clinic 裡，可以當成 Pod 來選',
          '`ipBlock` 寫 `his-db` 的 ClusterIP：程式連的是 Service 的這個位址',
          '不用寫：連到叢集外的流量不經過 CNI，NetworkPolicy 管不到它',
          '`ipBlock` 寫 10.20.5.31/32：多數 CNI 在 kube-proxy 改寫之後才比對',
        ],
        answer: 3,
        explain: 'kube-proxy 會把 `his-db` 的 ClusterIP 改寫成 EndpointSlice 裡的 10.20.5.31，多數 CNI 在這個改寫之後才比對 NetworkPolicy，所以規則要寫 Informix 的實際 IP。叢集外的位址用 `ipBlock`；`podSelector` 選的是 Pod，不是 Service。default deny 的 Egress 對連到叢集外的流量一樣有效，沒開這一條就是擋下。',
      },
    ],
  },
]
