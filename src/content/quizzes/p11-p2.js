// 題庫：P11 新課（p2 批）：container-registry、registry-retention、registry-airgap
export default [
  {
    skill: 'container-registry',
    questions: [
      {
        q: '`clinic/api:c2f81b6a` 與 `clinic/api:release-1.4.0` 指向同一個 digest。在 Harbor 上只刪掉 `c2f81b6a` 這個 tag，會發生什麼事？',
        options: [
          '這個映像的 layer 立刻從磁碟移除，`release-1.4.0` 之後也拉不到',
          '只拿掉一個名字；manifest 與 layer 都還在，`release-1.4.0` 照樣拉得到',
          'manifest 變成 untagged artifact，要等垃圾回收之後才能再用 `release-1.4.0` 拉',
          'Harbor 會拒絕這個操作，因為指向同一個 digest 的 tag 必須一起刪除',
        ],
        answer: 1,
        explain: 'tag 是指向 manifest 的名字，好幾個 tag 可以指向同一個 digest，刪掉其中一個只拿掉那個名字。manifest 還有 `release-1.4.0` 指著，不是 untagged artifact。blob 以內容的 SHA-256 存放，要等垃圾回收才會刪，而且只刪沒有任何 manifest 參照的。',
      },
      {
        q: 'CI 的 `docker login` 失敗，同一組帳密在自己電腦上登得進去。GitLab 的 CI/CD 變數 `HARBOR_ROBOT_USER` 設成 `robot$clinic-ci`。最可能的原因是什麼？',
        code: 'script:\n  - echo "$HARBOR_ROBOT_SECRET" | docker login -u "$HARBOR_ROBOT_USER" --password-stdin harbor.example.org',
        lang: 'yaml',
        options: [
          '機器人帳號不支援 `--password-stdin`，要改用 `-p` 把 secret 寫在指令列',
          '機器人帳號只能登入網頁介面，`docker login` 要改用個人帳號',
          'GitLab 把值裡的 `$clinic` 當成變數展開，帳號變成 `robot-ci`',
          '設成 Protected 的變數在所有分支都拿不到，要取消勾選才能登入',
        ],
        answer: 2,
        explain: '機器人帳號的名稱有 `$`。GitLab 預設會把變數值裡的 `$clinic` 當成另一個變數展開，帳號變成 `robot-ci`，登入失敗；`HARBOR_ROBOT_USER` 要取消勾選「Expand variable reference」，或在值裡寫成 `$$`。`--password-stdin` 讓密碼不出現在指令列，機器人帳號可以用。機器人帳號不能登入網頁介面，只能用工具或 API。受保護變數會注入受保護分支上的 pipeline。',
      },
      {
        q: 'CI 推送 `clinic/api` 與叢集拉取，目前都用一位已離職同事的 Harbor 個人帳號（他是 `clinic` 專案的 Developer）。要收掉這個帳號，又不讓 CI 與叢集中斷，哪個做法最合適？',
        options: [
          '先停用他的帳號，Harbor 偵測到帳號停用後，CI 與叢集會自動改用 admin 繼續存取，之後再慢慢換',
          '建一個 system 機器人帳號，勾選 Cover all projects 並給推送與拉取權限，CI 與叢集共用，設成永不過期以免中斷',
          '把 `clinic` 專案改成公開，叢集就不需要 pull secret；CI 改用另一位在職同事的個人帳號推送',
          '建兩個設了到期日的機器人帳號，CI 的能推送、叢集的只能拉取，放進受保護變數與 pull secret；確認正常後再移除他的帳號',
        ],
        answer: 3,
        explain: '機器人帳號不隨人員異動失效，範圍限縮到專案、推送與拉取分開，到期日提醒輪替；CI 的憑證放受保護變數，只有受保護分支的 pipeline 拿得到。先換憑證再收帳號，CI 與新排程的 Pod 才不會失敗。A 停用帳號後 CI 與叢集會因登入失敗而中斷，Harbor 不會自動改用 admin。B 的範圍是現在與未來的所有專案、又不過期，外洩時影響整座 Harbor。C 讓院內任何人都能拉應用程式映像，CI 也只是換成依賴另一個人的帳號。',
      },
    ],
  },
  {
    skill: 'registry-retention',
    questions: [
      {
        q: '`clinic/api` 套用保留規則後刪掉了 8,000 個舊 tag，Harbor 的磁碟用量卻幾乎沒變。最可能的原因是什麼？',
        options: [
          '保留規則刪掉的 tag 會先進資源回收筒，要過 30 天才會從磁碟移除',
          '專案配額把已刪除映像的空間保留給同一個專案，要把配額調低才會釋放',
          '刪 tag 只拿掉名字，layer 要等垃圾回收才移除，被保留的映像共用的層也不會釋放',
          '被刪的都成了 untagged artifact，Harbor 不計算它們的大小，所以用量看不出變化',
        ],
        answer: 2,
        explain: 'Harbor 的文件寫明刪除映像不會自動釋放空間，要跑垃圾回收，把不再被任何 manifest 參照的 blob 移除。即使跑了垃圾回收，被保留的映像共用的基底層與依賴層也不會被刪，釋放的量常比「刪掉的映像大小加總」小很多。Harbor 沒有資源回收筒，保留規則執行後無法復原；配額只限制用量、不保留空間；untagged artifact 一樣占用儲存空間。',
      },
      {
        q: '`clinic` 專案的保留規則是「最近推送的 5 個」與「`release-*` 一律保留」。九月的緊急修正直接用 commit SHA 的 tag `3a9d5e01` 部署到正式環境，之後又合併了十幾次。保留規則執行後會怎樣？',
        options: [
          'Harbor 查得到這個映像正在叢集裡跑，執行規則時會自動跳過它',
          '它被刪除，正在跑的 Pod 立刻因為映像不存在而被叢集重啟',
          '它被保留：部署時節點拉過一次，Harbor 把拉過的映像視為使用中',
          '它被刪除；Pod 照常運作，重排到沒有快取的節點時才拉不到',
        ],
        answer: 3,
        explain: 'Harbor 只知道推送時間、拉取時間與 tag 名稱，不知道哪個映像正在叢集裡跑。`3a9d5e01` 不在最近推送的 5 個裡，也不符合 `release-*`，沒被任何一條規則保留就會被刪。執行中的 Pod 不用再拉映像，所以照常運作，直到節點故障、Pod 重排到沒有快取的節點，才出現 `ImagePullBackOff`。正式環境只部署 release tag（緊急修正事後補打），並定期把叢集裡在跑的映像和 Harbor 比對。',
      },
      {
        q: '`clinic` 專案打開「Prevent vulnerable images from running」，等級設 Critical。一個剛推上來、還沒掃描完的映像，節點拉得到嗎？',
        options: [
          '拉得到；只有掃描結果確定有 Critical 弱點的映像才會被擋下',
          '拉不到；沒掃過、掃描失敗或還在掃的映像一樣會被擋下',
          '拉得到；這個設定擋的是 CI 的推送，不影響節點的拉取',
          '拉不到；要先把映像加進 CVE allowlist，才能跳過掃描直接拉',
        ],
        answer: 1,
        explain: '這個設定擋的是拉取，節點與 CI 一樣被擋；沒掃過、掃描失敗或還在掃的映像也拉不到。CVE allowlist 放的是確認不受影響的弱點（每一筆寫下理由與複查日期），不是讓映像跳過掃描。新公告的弱點會讓昨天拉得到的映像今天拉不到；執行中的 Pod 不受影響，節點故障重排時才起不來。',
      },
    ],
  },
  {
    skill: 'registry-airgap',
    questions: [
      {
        q: 'Harbor 上有一個代理 Docker Hub 的代理快取專案 `dockerhub-proxy`。Dockerfile 的 `FROM python:3.12-slim` 要改成哪一個？',
        options: [
          '`FROM harbor.example.org/dockerhub-proxy/python:3.12-slim`',
          '`FROM harbor.example.org/library/python:3.12-slim`',
          '`FROM harbor.example.org/dockerhub-proxy/library/python:3.12-slim`',
          '`FROM harbor.example.org/dockerhub-proxy/docker.io/python:3.12-slim`',
        ],
        answer: 2,
        explain: 'Docker Hub 的官方映像在 `library` 底下，`python:3.12-slim` 的完整名稱是 `docker.io/library/python:3.12-slim`。經由代理快取拉取時，院內位址是 `harbor.example.org/<代理專案>/<上游的映像路徑>`，所以專案名稱與 `library/` 都要寫出來，路徑裡不放上游 registry 的名稱。',
      },
      {
        q: '在跳板機（一台 arm64 筆電）上用下面的指令把 `pause` 複製進院內 Harbor。斷網叢集的 manifest 照上游的寫法，用上游的 digest 釘版本，只把 registry 改成院內位址。節點拉取時回 `manifest unknown`。原因與修法是什麼？',
        code: 'skopeo copy docker://registry.k8s.io/pause:3.10.1 \\\n  docker://harbor.example.org/k8s/pause:3.10.1\n\n# manifest 裡\nimage: harbor.example.org/k8s/pause:3.10.1@sha256:<上游的 digest>',
        lang: 'bash',
        options: [
          '沒加 `--all`，只複製了跳板機架構那一份、沒有多架構索引；加 `--all` 重新複製',
          'Harbor 收到映像後會重新壓縮 layer，digest 一定會變；斷網環境只能用 tag，不能用 digest',
          'Harbor 裡沒有事先建立 `pause` 這個 repository，skopeo 推送到不存在的 repository 時只寫入 tag、不寫入 manifest',
          'digest 綁定原本的 registry，換了 registry 就要用 `crane digest` 重算，把新的值寫回 manifest 就好',
        ],
        answer: 0,
        explain: 'digest 是內容的雜湊，內容相同、放在哪個 registry 都一樣，所以 manifest 可以帶著上游的 digest 進斷網環境。`pause` 是多架構映像，上游的 digest 指的是多架構索引；skopeo 預設只複製符合執行機器架構的那一份（這裡是 arm64），索引沒有過來。加 `--all` 複製每個架構與索引，`--preserve-digests` 在 digest 保不住時讓複製失敗。Harbor 不會重新壓縮 layer；repository 在推送時自動建立。照 D 重算只會得到 arm64 那一份的 digest，amd64 的節點仍然不能用。',
      },
      {
        q: '`clinic` namespace 的 Deployment 要拉 Harbor 私有專案的映像。pull secret 建在 `default` namespace，並寫進 `clinic` namespace 裡 `clinic-api` 這個 ServiceAccount 的 `imagePullSecrets`。新的 Pod 停在 `ImagePullBackOff`。最可能的原因是什麼？',
        options: [
          'ServiceAccount 不能帶 `imagePullSecrets`，只能寫在每個 Pod 的範本裡',
          'Secret 和 Pod 不在同一個 namespace，Pod 拿不到登入資訊',
          'pull secret 的型別要用 `Opaque`，`dockerconfigjson` 只給節點使用',
          '私有專案的映像只有 system 層級的機器人帳號才拉得到',
        ],
        answer: 1,
        explain: '`imagePullSecrets` 用的 Secret 型別是 `kubernetes.io/dockerconfigjson`，而且要和 Pod 在同一個 namespace。寫在 ServiceAccount 上是可以的：之後用這個 ServiceAccount 建立的 Pod 會自動帶上，已經存在的 Pod 不會。專案層級、只給拉取的機器人帳號就夠用。',
      },
    ],
  },
]
