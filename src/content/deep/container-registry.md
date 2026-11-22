## 同一個早上的三件事：拉不到、磁碟滿、離職同事還能推

週一早上，`clinic-api` 的 pipeline 一直失敗。資訊室的 Dockerfile 從院內 Harbor 的 `base` 專案 `FROM` 一個含 Informix 用戶端的 Python 3.12 slim 基底映像，再從 ghcr.io 複製 uv 的執行檔（`COPY --from=ghcr.io/astral-sh/uv:0.11.32`）。兩個 job 的錯誤（確切文字依版本而異）：

```text
# build-base：每月重建基底映像，FROM python:3.12-slim
failed to resolve source metadata for docker.io/library/python:3.12-slim: ... 429 Too Many Requests
toomanyrequests: You have reached your unauthenticated pull rate limit. ...

# build-image：clinic-api 本身
failed to resolve source metadata for ghcr.io/astral-sh/uv:0.11.32: ... dial tcp ...:443: i/o timeout
```

第一個 job 拉 Docker Hub：全院經由同一個對外 IP 出去，未登入的拉取次數依來源 IP 計算，早上幾十條 pipeline 就用完。第二個拉 ghcr.io，網路組上週收緊對外規則，它不在白名單裡。

有人登入 Harbor 想手動推 `python:3.12-slim` 救急，又看到兩件事：

- 儲存空間用了 92%。`clinic/api` 有一萬一千多個 tag，三年來每次合併推一個，從沒刪過。
- `clinic` 專案的成員裡有一位去年離職的同事，角色是 Developer，可以推送；CI 變數 `HARBOR_PASSWORD` 也是他的密碼。Harbor 用內建的資料庫帳號、沒接 AD，停用他的 AD 帳號影響不到這裡。

| 現象 | 原因 |
|---|---|
| 建置拉不到外部映像 | `FROM`、`COPY --from`、CI 的 `image:` 直接指向外部 registry |
| 磁碟快滿 | 沒有保留規則；刪掉 tag 也不會馬上釋放空間 |
| 離職同事還能推送，CI 用他的密碼 | 本機帳號不隨 AD 停用；CI 用個人帳號 |

## registry 存的是 manifest 與 layer，tag 只是名字

```text
clinic/api:c2f81b6a ────┐
clinic/api:release-1.4.0 ┴─→ manifest sha256:c2f8…
                                 ├─→ config sha256:7d1a…（啟動指令、環境變數）
                                 ├─→ layer  sha256:a1b2…（python:3.12-slim）    ← 其他版本也指向它
                                 ├─→ layer  sha256:c3d4…（Informix 用戶端）     ← 其他版本也指向它
                                 ├─→ layer  sha256:e5f6…（.venv）
                                 └─→ layer  sha256:0a9b…（程式碼）
```

- registry 存的是 **manifest**（一份 JSON，列出設定檔與每一層的 digest）、config 與 layer。config 與 layer 統稱 blob，以內容的 SHA-256 為名存放。
- tag 是指向某個 manifest 或索引的名字，好幾個 tag 可以指向同一個 digest。
- 拉取時，client 先向 `/v2/<repository>/manifests/<tag>` 要 manifest，再下載本機沒有的 blob。
- 同一個 blob 在儲存空間裡只放一份，不管多少映像用到它。

由此推得三件事：

1. 刪掉 tag 只拿掉名字。沒有 tag 的 manifest 成為 untagged artifact，blob 照樣在磁碟上，要等垃圾回收（garbage collection，GC）把沒有任何 manifest 參照的 blob 刪掉。
2. 共用的 layer 不會因為刪掉一個映像而釋放。
3. 介面上把每個映像的大小加起來，會遠大於實際占用的空間。

## 最小的設定：專案、機器人帳號、登入與推送

Harbor 是 CNCF 的開源 registry。三個設定就能推第一個映像：

1. **專案**：映像一定放在某個專案（project）底下，位址是 `harbor.example.org/<專案>/<repository>:<tag>`。私有專案只有成員能拉。
2. **角色**：成員的角色從 Guest 起能拉取，Developer 起能推送。人員通常只需要 Guest。
3. **機器人帳號**：推送交給機器人帳號（robot account）。它不能登入網頁介面，名稱是 `robot$<專案>+<名稱>`，建立時選權限與到期日，secret 只顯示一次。

```bash
# 單引號：帳號裡的 $ 不讓 shell 展開；密碼從 stdin 讀，不出現在指令列
echo "$HARBOR_ROBOT_SECRET" | docker login -u 'robot$clinic-ci' --password-stdin harbor.example.org
docker build --pull -t harbor.example.org/clinic/api:3f9c2a1b .
docker push harbor.example.org/clinic/api:3f9c2a1b      # tag 用 commit SHA，不推 latest
```

最常見的兩個錯誤：

| 訊息或現象 | 原因 | 怎麼修 |
|---|---|---|
| `unauthorized to access repository: clinic/api, action: push` | 沒有推送權限、機器人帳號過期或停用 | 看機器人帳號的權限與到期日 |
| CI 的 `docker login` 失敗，同一組帳密在自己電腦上登得進去 | GitLab 把 `robot$clinic-ci` 裡的 `$clinic` 當成變數展開 | 取消勾選「Expand variable reference」，或寫成 `$$` |

:::stop 讀到這裡可以先停：知道 registry 存的是 manifest 與 layer，會建專案與機器人帳號並推送映像。後面的 Harbor 權限模型、帳號來源、機器人帳號的輪替與 CI 推送，在要分權限、收掉個人帳號或把推送寫進 pipeline 時再回來讀。

## Harbor 的權限模型：專案、成員與機器人帳號

Harbor 在儲存映像之外加上權限、弱點掃描、保留規則、複製與代理快取。院內有自己的 registry，外部故障、限流或防火牆改規則時，已經在院內的映像照樣拉得到；拉取走院內網路；誰推了什麼、誰拉過都有紀錄；斷網的叢集也只能靠它。

明後年的 Kubernetes 叢集若是斷網或受限網路，三件事都會放大：節點拉不到外部映像，拉取用的憑證失效時，節點故障後重排的 Pod 起不來。

相關的課：image、tag、digest 與多架構映像在 [Docker：image、container、layer](#/skill/docker-basics)；映像掃描在 [幫 Python 專案寫好 Dockerfile](#/skill/dockerfile-python)；SBOM 與簽章在 [依賴與供應鏈安全](#/skill/supply-chain)；弱點的優先序在 [資安維運](#/skill/security-operations)。

下面講設定的意義，以 Harbor 2.x 為準；選單位置與欄位名稱隨版本調整，以官方文件為準。

### 專案與角色

映像一定放在某個專案（project）底下：`harbor.example.org/<專案>/<repository>:<tag>`。成員、配額、掃描、保留與不可變規則、機器人帳號都設在專案上。公開專案任何人不用登入就能拉，私有專案只有成員能拉。Harbor 安裝後有一個預設的公開專案 `library`。

成員的內建角色由低到高是 Limited Guest、Guest、Developer、Maintainer、Project Admin（較新的版本也能自訂角色）：Guest 起能拉取，Developer 起就能推送，Maintainer 起能刪除與掃描映像，Project Admin 管成員與專案設定。人員通常只需要 Guest，推送交給 CI 的機器人帳號。院內可以這樣切專案：

| 專案 | 公開或私有 | 放什麼 | 誰能推送 |
|---|---|---|---|
| `base` | 私有 | 資訊室維護的基底映像（含 Informix 用戶端的 Python 3.12 slim） | 基底映像的 CI |
| `clinic` | 私有 | 門診系統的應用程式映像 | `clinic-api` 的 CI |
| `dockerhub-proxy`、`ghcr-proxy`、`quay-proxy` | 依院內規定 | 外部映像的代理快取 | 沒有人（代理快取專案不能推送） |
| `k8s` | 私有 | 斷網叢集要用的 Kubernetes 元件、附加元件與 Helm chart | 同步 job |

### 帳號從哪裡來：資料庫、LDAP 或 OIDC

Harbor 的驗證方式有三種：自己的資料庫、LDAP 或 AD、OIDC。官方文件要求部署時就選定，資料庫裡一旦有 admin 以外的本機帳號，就不能再切換到 LDAP；開頭那位同事的就是這種帳號。

- 接 LDAP 時，可以把 AD 群組加進專案並給角色（AD 端要有 `memberof` 屬性），人員異動跟著群組走，見 [企業身分：LDAP、AD、SAML 與 SCIM](#/skill/enterprise-identity)。
- 接 OIDC 時，`docker login` 不能走網頁登入，Harbor 給每位使用者一組 CLI secret 當密碼。離職流程要確認它也不能再用。
- 安裝設定檔裡的預設 admin 密碼，第一次登入後就換掉；admin 不給 CI 用。

### 機器人帳號

機器人帳號（robot account）給程式用，不能登入網頁介面，只能用 `docker`、`skopeo` 這類工具或 API。專案層級的只能操作所在的專案，名稱是 `robot$<專案>+<名稱>`；Harbor 2.2 起另有 system 層級的，由系統管理者建立，可以涵蓋多個專案、每個專案給不同權限（勾選「Cover all projects」時連之後新建的專案也包含）。建立時選權限（推送必須搭配拉取）與到期日；secret 只在建立時顯示一次，遺失或外洩就 refresh 產生新的，舊的立即失效。

| 用途 | 機器人帳號 | 權限 | 憑證放哪裡 |
|---|---|---|---|
| `clinic-api` 的 CI | system 層級 `robot$clinic-ci`，只勾 `clinic` 與 `base` | `clinic` 推送與拉取；`base` 只拉取（`FROM` 基底映像） | GitLab 的受保護變數，secret 另外勾遮蔽 |
| 叢集拉應用程式映像 | 專案層級 `robot$clinic+k8s-pull` | `clinic` 只拉取 | `clinic` namespace 的 pull secret |
| 基底映像的 CI | 專案層級 `robot$base+gitlab-ci` | `base` 推送與拉取 | 基底映像 repo 的受保護變數 |
| 斷網同步 | 專案層級 `robot$k8s+sync` | `k8s` 推送與拉取 | 跳板機上的憑證檔，只有同步帳號讀得到 |

到期那天什麼都不會壞，執行中的 Pod 不用再拉。壞在下一次需要拉取時：滾動更新、節點故障後 Pod 重排、新節點加入。到期日寫進維運日曆，到期前輪替（refresh secret、更新 GitLab 變數與 pull secret），見 [金鑰的範圍與壽命](#/skill/key-scope-lifetime)。機器人帳號不隨人員離職失效，每季列一次用途、權限與到期日，從專案的操作紀錄看是否還在用。

開頭那位同事的處理順序：先建好上表的機器人帳號，換掉 CI 變數與叢集的 pull secret，確認 pipeline 與 Pod 都正常，再移除他的成員資格、刪除帳號。順序反過來，pipeline 會立刻失敗。

## CI 推送：機器人帳號、受保護變數與 digest

```yaml
build-image:
  stage: build
  image: harbor.example.org/dockerhub-proxy/library/docker:27
  services:
    - name: harbor.example.org/dockerhub-proxy/library/docker:27-dind
      alias: docker                  # 預設的主機名稱由映像名稱產生，改了位址就不叫 docker
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
    IMAGE: harbor.example.org/clinic/api
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH   # 受保護分支才拿得到受保護變數
  script:
    # HARBOR_ROBOT_USER 與 HARBOR_ROBOT_SECRET 設在專案的 CI/CD 變數：都勾 Protected，secret 另外勾 Masked
    - echo "$HARBOR_ROBOT_SECRET" | docker login -u "$HARBOR_ROBOT_USER" --password-stdin harbor.example.org
    - docker build --pull -t "$IMAGE:$CI_COMMIT_SHORT_SHA" .
    - docker push "$IMAGE:$CI_COMMIT_SHORT_SHA"
    # 推送後 RepoDigests 才有值；把 digest 交給後面的部署 job
    - echo "IMAGE_REF=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE:$CI_COMMIT_SHORT_SHA")" > build.env
  artifacts:
    reports:
      dotenv: build.env              # 後面的 job 會拿到 $IMAGE_REF
```

- 用機器人帳號，不用任何人的個人帳號；`--password-stdin` 讓密碼不出現在指令列。受保護變數只注入受保護分支上的 pipeline，所以 job 用 `rules` 限定在預設分支，見 [GitLab CI/CD 實戰](#/skill/gitlab-cicd)。
- 機器人帳號的名稱有 `$`（`robot$clinic-ci`）。GitLab 預設會把變數值裡的 `$clinic` 當成另一個變數展開，帳號變成 `robot-ci`，登入失敗。`HARBOR_ROBOT_USER` 要取消勾選「Expand variable reference」，或在值裡寫成 `$$`；在 shell 裡用單引號。
- tag 用 commit SHA，不推 `latest`。發版時另外加 `release-<版本>` 的 tag（例如 `crane tag harbor.example.org/clinic/api:3f9c2a1b release-1.5.0`），由不可變規則保護（見 [映像倉庫的清理與把關：保留規則、垃圾回收、不可變 tag 與弱點掃描](#/skill/registry-retention)）。部署 job 用 `$IMAGE_REF`（`…/clinic/api@sha256:…`），叢集跑的是這次建出來的那一份。
- 參考專案 `companion/clinic-api` 用的是 GitLab Container Registry 的位址（`registry.gitlab.example/clinic/api`），換成 Harbor 只改 `image` 與登入步驟。

GitLab 內建的 Container Registry 每個專案一個，和 GitLab 的權限與 `CI_REGISTRY_PASSWORD` 這類預定義變數整合，推送不用另外管帳號，也有清理政策（自架版刪 tag 後同樣要跑垃圾回收）；GitLab 的 Dependency Proxy 也能代理 Docker Hub。Harbor 多的是多種上游的代理快取、與其他 registry 之間的複製、registry 端的掃描與阻擋拉取，以及專案層級的保留、不可變規則與配額。基底映像已經在 Harbor，應用程式映像也放 Harbor 的話，叢集只要信任一個 registry、管一組 pull secret。

## 常見錯誤與錯誤訊息

訊息的確切文字依版本與工具而異，下面是類似的樣子：

| 訊息或現象 | 原因 | 怎麼修 |
|---|---|---|
| `unauthorized to access repository: clinic/api, action: push` | 沒有推送權限、機器人帳號過期或停用 | 看機器人帳號的權限與到期日 |
| CI 的 `docker login` 失敗，同一組帳密在自己電腦上登得進去 | GitLab 把 `robot$clinic-ci` 裡的 `$clinic` 當成變數展開 | 取消勾選「Expand variable reference」，或寫成 `$$` |
| CI 改用院內位址的 dind 後 `Cannot connect to the Docker daemon` | 服務的主機名稱由映像名稱產生，不再叫 `docker` | `services:` 加 `alias: docker` |

## 動手

1. 替院內 Harbor 寫一張盤點表：每個專案的成員與角色、機器人帳號（用途、權限、到期日、憑證放哪）。
2. 有測試用的 Harbor 時：建一個私有專案與一個只能拉取的機器人帳號，用它 `docker login` 之後試著 `docker push`，看 `unauthorized to access repository` 的訊息。
3. 把手邊一條 pipeline 的登入步驟對照本課的 `build-image`：帳號是不是機器人帳號、變數有沒有勾 Protected 與 Masked、tag 是不是 commit SHA。

後續的課：保留規則、垃圾回收、配額、不可變 tag 與弱點掃描在 [映像倉庫的清理與把關：保留規則、垃圾回收、不可變 tag 與弱點掃描](#/skill/registry-retention)；Docker Hub 限流、代理快取、叢集拉取與斷網搬運在 [外部映像與斷網環境：代理快取、叢集拉取與映像搬運](#/skill/registry-airgap)。
