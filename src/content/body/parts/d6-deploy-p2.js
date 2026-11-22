// 領域內文（d6-deploy，p2 批）：以技能 id 為 key，由 body/d6-deploy.js 合併。只放這些技能：container-registry、registry-retention、registry-airgap
export default {
  'container-registry': {
    map: {
      names: [
        { n: 'manifest 與 layer（blob）', t: 'manifest 是一份 JSON，列出設定檔與每一層的 digest；config 與 layer 統稱 blob，以內容的 SHA-256 為名存放，同一個 blob 只放一份。' },
        { n: 'tag', t: '指向某個 manifest 或索引的名字，好幾個 tag 可以指向同一個 digest。' },
        { n: '專案（project）', t: '映像一定放在某個專案底下，位址是 `harbor.example.org/<專案>/<repository>:<tag>`；成員、機器人帳號與各種規則都設在專案上。' },
        { n: '角色', t: 'Guest 起能拉取，Developer 起就能推送，Maintainer 起能刪除與掃描映像，Project Admin 管成員與專案設定。' },
        { n: '機器人帳號（robot account）', t: '給程式用，不能登入網頁介面；名稱是 `robot$<專案>+<名稱>`，建立時選權限與到期日，secret 只顯示一次。' },
        { n: '受保護變數', t: 'GitLab 只把它注入受保護分支上的 pipeline；機器人帳號的 secret 放這裡，另外勾遮蔽。' },
      ],
      ask: [
        '映像放哪個專案，專案是公開還是私有。',
        '誰能推送、誰只能拉取；CI 與叢集各用哪個機器人帳號、什麼權限、何時到期。',
        '人員帳號從哪裡來（資料庫、LDAP 或 OIDC），離職時怎麼失效。',
        'tag 怎麼命名（commit SHA、`release-<版本>`），部署用 tag 還是 digest。',
      ],
      prompt: '`clinic-api` 的 CI 把映像推到院內 Harbor 的私有專案 `clinic`：用機器人帳號 `robot$clinic-ci`，權限是 `clinic` 推送與拉取、`base` 只拉取；帳號與 secret 放 GitLab 的受保護變數（secret 勾 Masked，帳號取消「Expand variable reference」），`docker login` 用 `--password-stdin`。tag 用 commit SHA、不推 `latest`，推送後把 digest 交給部署 job。',
      verify: [
        { c: '誰能推送', t: '看專案的成員清單：人員通常只需要 Guest，Developer 以上就能推送。Harbor 用內建的資料庫帳號時，停用 AD 帳號影響不到這裡。' },
        { c: 'CI 用的是誰的帳號', t: 'CI 變數裡的帳號要是 `robot$` 開頭；是個人帳號就換掉，先換憑證、確認 pipeline 正常，再收帳號。' },
        { c: '登入失敗', t: '同一組帳密在自己電腦上登得進去、CI 的 `docker login` 卻失敗，先看 GitLab 有沒有把 `robot$clinic-ci` 裡的 `$clinic` 當成變數展開。' },
        { c: '推送失敗', t: '`unauthorized to access repository: clinic/api, action: push`：看機器人帳號的權限、到期日與是否停用。' },
      ],
    },
    points: [
      { b: 'registry 存 manifest 與 layer，tag 只是指標', t: 'manifest 列出設定與每一層的 digest，layer 以內容雜湊存放、同一層只存一份，多架構映像多一層索引。刪 tag 只拿掉名字，空間要等垃圾回收把沒有任何 manifest 參照的 layer 清掉；被保留的映像共用的基底層與依賴層不會釋放。' },
      { b: 'Harbor 用專案分權限，CI 與叢集用機器人帳號', t: '專案分公開與私有，內建角色從 Limited Guest 到 Project Admin，Developer 起就能推送。人員帳號接 LDAP 或 OIDC，部署時就選定。CI 推送與叢集拉取各用一個機器人帳號，範圍限縮到專案與動作、設到期日；它不隨人員離職失效，要列冊、到期前輪替。' },
      { b: '帳號來源在部署時就選定', t: 'Harbor 的驗證方式有自己的資料庫、LDAP 或 AD、OIDC 三種；資料庫裡一旦有 admin 以外的本機帳號，就不能再切換到 LDAP。接 LDAP 可以把 AD 群組加進專案並給角色；接 OIDC 時 `docker login` 用 CLI secret 當密碼，離職流程要確認它也不能再用。' },
      { b: '機器人帳號到期那天什麼都不會壞', t: '執行中的 Pod 不用再拉；壞在下一次需要拉取時：滾動更新、節點故障後 Pod 重排、新節點加入。到期日寫進維運日曆，到期前 refresh secret、更新 GitLab 變數與 pull secret；每季列一次用途、權限與到期日。' },
      { b: 'CI 推送：受保護變數、SHA tag 與 digest', t: '機器人帳號的名稱與 secret 放受保護變數，job 用 `rules` 限定在預設分支；名稱裡的 `$` 要取消變數展開或寫成 `$$`。tag 用 commit SHA、不推 `latest`，發版時另外加 `release-<版本>` 的 tag；部署 job 用推送後取得的 digest。' },
    ],
    checklist: [
      '能替院內 Harbor 規劃專案（基底、應用、代理快取、斷網同步）與機器人帳號，說出 CI 與叢集各拿什麼權限、憑證放在哪裡、到期前怎麼輪替',
      '能說明 manifest、layer 與 tag 的關係，以及刪掉 tag 為什麼不會馬上釋放空間',
      '能把 CI 的推送從個人帳號換成機器人帳號，並排出先換憑證、再收帳號的順序',
    ],
    challenge: {
      task: '門診系統之外，檢驗系統 `lab-api` 也要把映像放進院內 Harbor：Dockerfile `FROM` 資訊室 `base` 專案的基底映像，CI 在 GitLab，映像由叢集的 `lab` namespace 拉取；廠商的兩位工程師要看得到映像，但不能推送。照本課「機器人帳號」的表格，替它列出專案、成員角色與機器人帳號。動手前先預測：總共需要幾個機器人帳號，哪一個的權限最大。',
      deliver: '一張表：專案、成員與角色、每個機器人帳號的層級、權限、到期日與憑證放哪裡',
      check: [
        '沒有任何人員帳號有推送權限',
        'CI 的機器人帳號對 `base` 只有拉取；叢集用的機器人帳號只有拉取',
        '每個機器人帳號都有到期日，並寫出到期前要更新哪些地方的憑證',
        '預測與最後的答案並列',
      ],
      twist: '半年後，`lab-api` 的 CI 機器人帳號 secret 出現在一份外流的 pipeline log 裡。先預測：refresh secret 之後哪些東西會立刻失敗、哪些不受影響，再排出處理順序。',
    },
    refs: [
      { label: 'Harbor：Create Project Robot Accounts', url: 'https://goharbor.io/docs/main/working-with-projects/project-configuration/create-robot-accounts/' },
    ],
  },
  'registry-retention': {
    map: {
      names: [
        { n: '保留規則（tag retention）', t: '設在專案上，只寫要保留什麼，沒被任何一條保留的就刪；規則之間是 OR，執行後無法復原。' },
        { n: '垃圾回收（GC）', t: '把不再被任何 manifest 參照的 blob 刪掉；刪 tag 之後要跑它才釋放空間。' },
        { n: 'untagged artifact', t: '沒有 tag 的 manifest：tag 被刪掉，或被重推的同名 tag 移走之後留下，blob 照樣占空間。' },
        { n: '不可變 tag（tag immutability）', t: '符合樣式的 tag 推過一次就不能被覆蓋，它指向的 artifact 也不能刪；適合 `release-*`。' },
        { n: '配額', t: '專案的儲存空間上限，預設沒有上限；超過時推送失敗。' },
        { n: '「Prevent vulnerable images from running」', t: '映像有指定等級或更高的弱點時，Harbor 拒絕拉取；沒掃過、掃描失敗或還在掃的也拉不到。' },
        { n: 'CVE allowlist', t: '確認不受影響的弱點加進來，每一筆寫下理由與複查日期。' },
      ],
      ask: [
        '每個 repository 保留哪些：最近推送的幾個、幾天內拉取過的、哪些 tag 樣式一律保留。',
        '哪些 tag 樣式設成不可變。',
        '保留規則與垃圾回收的排程與先後順序，第一次執行前先 dry run。',
        '弱點到哪個等級要擋拉取，allowlist 由誰審核。',
        '正式環境部署的映像怎麼保證不被刪（只部署 release tag、定期和叢集比對）。',
      ],
      prompt: '`clinic` 專案的保留規則：`release-*` 一律保留並設成不可變，另外保留最近推送的 20 個與 30 天內拉取過的。每週固定時段先跑保留規則、再跑垃圾回收，第一次執行前兩者都先 dry run。推送時自動掃描，先只看報告；處理流程與 allowlist 的審核人排好後，再對 Critical 打開阻擋拉取。',
      verify: [
        { c: '規則會刪掉什麼', t: '保留規則先 dry run；確認正式環境在跑的映像（`kubectl get pods -A -o jsonpath=\'{..image}\'`）都在保留的那一邊。' },
        { c: '空間有沒有釋放', t: '刪 tag 當下釋放的是 0，要等垃圾回收；垃圾回收的 dry run 會估算能釋放的空間，比介面上的映像大小加總小很多是正常的。' },
        { c: '不可變有沒有生效', t: '再推一次同名的 `release-*` tag，應該得到 `configured as immutable`。' },
        { c: '阻擋拉取的副作用', t: '打開後，沒掃過、掃描失敗或還在掃的映像也拉不到；斷網時弱點資料庫停止更新，掃描會一直回報沒有新弱點。' },
      ],
    },
    points: [
      { b: '刪 tag 不等於釋放空間', t: '刪掉 tag 只拿掉名字，blob 要等垃圾回收；被保留的映像共用的基底層與依賴層不會釋放，介面上把映像大小加起來，會遠大於實際釋放的量。垃圾回收有 dry run，最近 2 小時內上傳的 blob 不會被刪。' },
      { b: '保留規則、不可變 tag、垃圾回收與配額一起設', t: '保留規則依推送數、推送或拉取天數、tag 樣式保留，規則之間是 OR，一個 tag 符合就保留整個 artifact，執行後無法復原。規則不知道哪個映像正在跑，部署用的版本靠 release tag 加不可變規則保住。保留規則之後排垃圾回收，用配額限制每個專案的用量。' },
      { b: '保留規則不知道哪個映像正在跑', t: 'Harbor 只知道推送時間、拉取時間與 tag 名稱。節點用 `imagePullPolicy: IfNotPresent` 時，映像拉過一次就用快取，跑了兩個月的版本看起來就是兩個月沒人拉。正式環境只部署 release tag，定期把叢集裡實際在跑的映像和 Harbor 比對。' },
      { b: '不可變 tag 只給 release', t: '不可變規則用 repository 與 tag 的樣式比對，符合的 tag 不能被覆蓋，指向的 artifact 也不能刪。每個 commit 的 SHA tag 不要設：保留規則清不掉，磁碟會一直長。' },
      { b: '推送後掃描，可以擋下有高風險弱點的映像', t: 'Harbor 內建 Trivy，可以推送時自動掃描、排程全部重掃，並設「某個等級以上就不准拉」。打開後沒掃過或掃描失敗的映像也拉不到，節點重排 Pod 時才會發現。確認不受影響的弱點加進 CVE allowlist 並寫理由；斷網時弱點資料庫要另外同步。' },
    ],
    checklist: [
      '能寫出一組保留規則，說明哪些 artifact 會被刪、為什麼刪完要跑垃圾回收、共用的 layer 為什麼不會釋放，以及怎麼避免刪到正在部署的映像',
      '能排出保留規則與垃圾回收的執行順序與排程，並說明第一次執行前為什麼要 dry run',
      '能說明打開「有高風險弱點就不准拉」之後哪些映像會拉不到、什麼時候才會發現，以及 CVE allowlist 怎麼用',
    ],
    challenge: {
      task: '執行本課「模擬：三條保留規則加一道安全網」的程式（區塊下方有「在 Playground 開啟」）。把規則改成 `KEEP_LATEST = 3`、`PULLED_WITHIN = 7`、`PATTERNS = ("release-1.4*",)`。執行前先預測：哪幾個 artifact 會被刪、哪一個只靠安全網留下、垃圾回收後釋放的空間比較接近「被刪映像的大小加總」還是遠小於它。再做程式題 [模擬 Harbor 的保留規則，並估算垃圾回收後釋放的空間](#/exercise/container-registry-1)。',
      deliver: '預測與程式輸出的對照表，以及一段說明：釋放的空間來自哪幾層、其他層為什麼沒有釋放',
      check: [
        '預測在執行前寫下，和輸出並排',
        '指出只靠安全網留下的 artifact，並說明在真的 Harbor 上它會怎樣',
        '逐層說明釋放與沒釋放的原因（還被保留的映像參照，或由 `base` 專案持有）',
        '程式題的測試全部通過',
      ],
      twist: '`base` 專案也清掉了 2024 年的基底映像：把 `REFERENCED_ELSEWHERE` 改成 `set(BASE_2026)`。先預測釋放的空間會多出哪幾層、大約多少 MB，再執行。',
    },
    refs: [
      { label: 'Harbor：Create Tag Retention Rules', url: 'https://goharbor.io/docs/main/working-with-projects/working-with-images/create-tag-retention-rules/' },
      { label: 'Harbor：Garbage Collection', url: 'https://goharbor.io/docs/main/administration/garbage-collection/' },
    ],
  },
  'registry-airgap': {
    map: {
      names: [
        { n: '代理快取專案（proxy cache）', t: '第一次有人拉時向上游取並快取；不能推送。Docker Hub 的官方映像要寫出 `library/`：`harbor.example.org/dockerhub-proxy/library/python:3.12-slim`。' },
        { n: '複製（replication）', t: 'Harbor 依規則從外部 registry 拉進來，或推到另一座 Harbor；手動、排程或推送事件觸發。' },
        { n: 'skopeo、crane', t: '不需要 Docker daemon，直接在 registry 之間搬 manifest 與 blob；`skopeo copy --all`、`crane copy` 會帶上每個架構與多架構索引。' },
        { n: '多架構索引（image index）', t: '指向每個架構的 manifest。複製時沒帶過來，用上游 digest 釘版本的映像在院內會回 `manifest unknown`。' },
        { n: '`imagePullSecrets`', t: '型別是 `kubernetes.io/dockerconfigjson` 的 Secret，要和 Pod 在同一個 namespace；寫在 ServiceAccount 上，之後建立的 Pod 會自動帶上。' },
        { n: '`hosts.toml`', t: 'containerd 對某個 registry 的設定：信任的院內 CA（`ca`），以及鏡像（mirror）。' },
        { n: '拉取次數上限', t: 'Docker Hub 對未登入（依來源 IP 計算）與免費帳號有上限，計算的是取得 manifest 的請求。' },
      ],
      ask: [
        '建置與部署用到哪些外部 registry，各自走代理快取、複製還是同步 job。',
        '`FROM`、`COPY --from`、CI 的 `image:` 與 `services:` 改成哪個院內位址。',
        '叢集用哪個機器人帳號拉取，pull secret 放哪個 namespace、掛在哪個 ServiceAccount。',
        '節點、CI 的 dind 與開發機怎麼信任院內 CA。',
        '斷網環境的映像清單從哪些地方列，複製時怎麼保留 digest 與多架構，由誰核可。',
      ],
      prompt: '`clinic-api` 的 Dockerfile 把 `FROM python:3.12-slim` 改成 `harbor.example.org/dockerhub-proxy/library/python:3.12-slim`，`COPY --from=ghcr.io/astral-sh/uv:0.11.32` 改成 `harbor.example.org/ghcr-proxy/astral-sh/uv:0.11.32`，階段名稱不改。叢集的 `clinic` namespace 用只能拉取的機器人帳號建 pull secret，掛在 `clinic-api` 的 ServiceAccount；節點的 containerd 用 `hosts.toml` 信任院內 CA。斷網叢集要的映像用 `skopeo copy --all --preserve-digests` 複製到 `k8s` 專案。',
      verify: [
        { c: '還有沒有外部位址', t: '在 Dockerfile、`.gitlab-ci.yml` 與 `helm template` 的輸出裡找 `FROM`、`COPY --from`、`image:`；沒寫 registry 與 tag 的 `busybox` 是 `docker.io/library/busybox:latest`。' },
        { c: 'digest 有沒有保住', t: '`crane digest` 對上游與院內各跑一次，兩邊要一樣；不一樣多半是只複製了單一架構的那一份。' },
        { c: '拉取失敗的原因', t: '`kubectl describe pod` 的 Events：`x509: certificate signed by unknown authority` 是節點不信任院內 CA；`ImagePullBackOff` 再看 pull secret 的機器人帳號有沒有過期。' },
        { c: '清單有沒有漏', t: '在一座同樣斷網的測試叢集裡完整安裝一次，看 `kubectl get events -A` 有沒有拉取失敗；寫在啟動參數裡的映像最容易漏。' },
      ],
    },
    points: [
      { b: '外部映像走代理快取或事先同步，斷網就全部搬進來', t: 'Docker Hub 對未登入（依來源 IP 計算）與免費帳號有拉取次數上限。Harbor 的代理快取專案代理 Docker Hub、ghcr.io、quay.io 等，`FROM`、`COPY --from` 與 CI 的 `image:` 改指院內位址，官方映像要寫出 `library/`。斷網環境列出應用、基底、CI、K8s 元件與 Helm chart 用到的每個映像，用 skopeo 或 crane 保留 digest 與多架構複製，K8s 升級前先同步。' },
      { b: '三種帶進院內的做法', t: '代理快取：有人拉才向上游取，上游斷線時沒快取過的拉不到，適合 Harbor 能連外、節點與 Runner 不能的受限網路。複製：兩座 Harbor 之間，例如正式與災備。同步 job（skopeo、crane）：照清單事先複製，適合斷網環境與要先審核再放行的映像。' },
      { b: '叢集用 pull secret 拉私有專案', t: 'Secret 的型別是 `kubernetes.io/dockerconfigjson`，要和 Pod 在同一個 namespace；寫在 ServiceAccount 的 `imagePullSecrets`，之後建立的 Pod 會自動帶上，機器人帳號只給拉取。拉映像的是節點上的 containerd，每台節點、CI 的 dind 與開發機的 Docker 都要信任院內 CA。' },
      { b: '複製要保留 digest 與多架構', t: '用 `skopeo copy --all --preserve-digests` 或 `crane copy`。用 `docker pull`、`docker tag`、`docker push` 搬，或 skopeo 沒加 `--all`，只會拿到執行機器那個架構的一份；manifest 用索引的 digest 釘版本時，院內會回 `manifest unknown`。' },
      { b: '斷網清單從每個會拉映像的地方列', t: '應用程式的 manifest（含 CronJob、initContainers）、Dockerfile、CI 的 `image:` 與 Runner 的 helper 映像、`kubeadm config images list`、附加元件與 Helm chart。寫在啟動參數裡的映像容易漏，最後在斷網的測試叢集完整安裝一次。完全隔離的網段先把映像存成檔案、附上雜湊清單，經核可的管道搬進去。' },
    ],
    checklist: [
      '能列出一座斷網叢集需要的所有映像（含 K8s 元件與 Helm chart 用到的），保留 digest 與多架構搬進院內，並讓節點信任院內 CA、透過 ServiceAccount 的 pull secret 拉得到',
      '能把 Dockerfile 與 CI 裡的外部映像改成代理快取的院內位址，並說明代理快取、複製與同步 job 各自適合的情況',
      '能說明 Docker Hub 未登入的拉取次數怎麼計算，以及全院共用一個出口 IP 時為什麼很快用完',
    ],
    challenge: {
      task: '照本課「動手」第 3 步，在 kind 旁邊起一個本機 `registry:2`，用 `crane copy` 把多架構的 `postgres:16` 複製進去，再用不加 `--all` 的 `skopeo copy` 複製一份到另一個路徑。部署到 kind 之後，從三個地方取 digest 核對：上游（`crane digest`）、本機 registry、節點實際跑的（`kubectl get pod <名稱> -o jsonpath=\'{.status.containerStatuses[*].imageID}\'`）。',
      deliver: '三個來源的 digest 對照表，以及兩條複製路徑各自部署的結果',
      check: [
        '表中的每個 digest 都來自實際指令的輸出',
        '指出不加 `--all` 那一份的 digest 和上游不同，並說明它是單一架構的 manifest',
        'manifest 用上游 digest 釘版本時，只有保留多架構索引的那一份拉得起來',
        '寫出事後怎麼從正在跑的 Pod 反查它用的 digest',
      ],
      twist: '院內 Harbor 開了「有高風險弱點就不准拉」，這個 digest 一週後被掃出 Critical。先預測：正在跑的 Pod 會怎樣、節點重排時會怎樣、要在不換 digest 的前提下讓它繼續跑得做什麼。',
    },
    refs: [
      { label: 'Harbor：Configure Proxy Cache', url: 'https://goharbor.io/docs/main/administration/configure-proxy-cache/' },
      { label: 'Docker Hub：Usage and limits', url: 'https://docs.docker.com/docker-hub/usage/pulls/' },
      { label: 'Kubernetes：Images（私有 registry 與 pull secret）', url: 'https://kubernetes.io/docs/concepts/containers/images/' },
      { label: 'Kubernetes：Pull an Image from a Private Registry', url: 'https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/' },
      { label: 'containerd：Registry Configuration（hosts.toml）', url: 'https://github.com/containerd/containerd/blob/main/docs/hosts.md' },
      { label: 'skopeo', url: 'https://github.com/containers/skopeo' },
      { label: 'crane', url: 'https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md' },
    ],
  },
}
