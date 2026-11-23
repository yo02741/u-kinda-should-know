## 一份「能動就好」的 .gitlab-ci.yml

一家醫院資訊部的預約系統放在自架的 GitLab 上，`.gitlab-ci.yml` 是幾年前寫的：

```yaml
deploy:
  script:
    - pip install -r requirements.txt
    - pytest
    - sshpass -p 'P@ssw0rd2023' ssh deploy@10.20.0.15 "cd /srv/booking && git pull && systemctl restart booking"
```

它能動，但有四個問題：

- **密碼寫在檔案裡**：能讀這個 repo 的人都看得到，刪掉這一行它也留在 git 歷史中。
- **任何分支都會部署**：有人在功能分支 push 一次，正式環境就換成那個分支的程式碼。
- **測試和部署在同一個 job**：測試連的資料庫沒有定義；有人在 `pytest` 後面加 `|| true`，壞掉的程式也會上線。
- **正式環境跑的東西無法追溯**：`git pull` 拉的是那一刻的最新程式碼，部署紀錄看不出是哪個 commit，也沒有可以回退的版本。

## .gitlab-ci.yml 的結構：全域設定與 job

GitLab 讀取 repo 根目錄的 `.gitlab-ci.yml`，每次 push、建立 merge request（MR）或排程觸發時，依內容建立一條 **pipeline**。頂層鍵分兩類：

- **全域設定**：`stages`、`variables`、`workflow`、`default`、`include` 等保留字。
- **job**：其他頂層鍵都是 job 的名字。名字以 `.` 開頭的是隱藏 job，不會執行，常拿來當範本給 `extends` 用。

每個 job 至少要有 `script`。常用的 job 關鍵字：

| 關鍵字 | 作用 |
|---|---|
| `stage` | 這個 job 屬於哪一個 stage；沒寫就是 `test` |
| `image` | 用哪個 container image 執行（Docker / Kubernetes executor） |
| `services` | 另外起的容器，例如測試用的 PostgreSQL |
| `script` / `before_script` | 要執行的指令；任何一行結束碼不是 0，job 就失敗 |
| `variables` | 這個 job 的環境變數 |
| `rules` | 這個 job 在什麼條件下出現在 pipeline 裡、以什麼方式執行 |
| `needs` | 這個 job 只等哪些 job，不等整個前一個 stage |
| `artifacts` | job 結束後要保留、傳給後續 job 或供下載的檔案 |
| `cache` | 跨 pipeline 重用的檔案（例如套件下載快取） |
| `environment` | 這個 job 部署到哪個環境，GitLab 會記錄部署歷史 |
| `tags` | 要在帶有這些標籤的 Runner 上執行 |

## 改寫後的完整範例

```yaml
stages:
  - test
  - build
  - deploy

# 同一個 commit 不要同時跑「分支 pipeline」和「MR pipeline」（GitLab 文件提供的寫法）
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH

variables:
  UV_CACHE_DIR: "$CI_PROJECT_DIR/.cache/uv"   # 把 uv 的下載快取放在專案目錄裡，cache 才存得到

# 隱藏 job：Python 環境的共同設定，給下面的 job extends
.python:
  image: python:3.12-slim
  before_script:
    - pip install uv
    - uv sync --frozen               # 依 uv.lock 安裝，lock 檔不符就失敗
  cache:
    key:
      files: [uv.lock]               # lock 檔改了才換新的快取
    paths: [.cache/uv]

lint:
  extends: .python
  stage: test
  script:
    - uv run ruff check .

test:
  extends: .python
  stage: test
  services:
    - name: postgres:16
      alias: db                      # job 裡用 db 這個主機名稱連到它
  variables:
    # 這組帳密只屬於這個 job 臨時起的空資料庫，job 結束就銷毀，不是機密
    POSTGRES_DB: app_test
    POSTGRES_USER: app
    POSTGRES_PASSWORD: test-only
    DATABASE_URL: "postgresql://app:test-only@db:5432/app_test"
  script:
    - uv run pytest --junitxml=report.xml
  artifacts:
    when: always                     # 測試失敗也要保留報告
    reports:
      junit: report.xml              # MR 頁面會顯示哪些測試失敗
    expire_in: 1 week

build-image:
  stage: build
  image: docker:27
  services:
    - docker:27-dind                 # 在 job 裡提供 Docker daemon（Runner 要允許 privileged）
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH   # 只有合進預設分支才 build
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"

deploy-production:
  stage: deploy
  image: alpine:3.22
  needs: [build-image]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual                   # 要有人在 GitLab 介面上按下才執行
  environment:
    name: production
    url: https://booking.example.org
  resource_group: production         # 同一時間只允許一個部署在跑
  script:
    # DEPLOY_SSH_KEY 是在專案設定裡建立的 File 型、protected 變數，不在這個檔案裡
    - apk add --no-cache openssh-client
    - ssh -i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=yes deploy@"$DEPLOY_HOST"
        "/srv/booking/deploy.sh $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"
```

## job 的順序與出現條件：stages、needs、rules

- **stage 是一道柵欄**：同一個 stage 的 job 平行執行；前一個 stage 的 job 全部成功，下一個 stage 才開始。
- **`needs` 把柵欄換成依賴關係**：寫了 `needs: [build-image]` 的 job 只等 `build-image`。沒列進 needs 的 job 失敗，不會擋住它。
- **`rules` 由上往下比對，第一條符合的規則生效**，後面的不再看；都不符合時，job 不會出現在 pipeline 裡。

每條規則可以帶 `when`：

| `when` | 效果 |
|---|---|
| `on_success`（預設） | 前面的 stage 都成功就執行 |
| `manual` | 出現按鈕，要有人按才執行 |
| `always` | 不管前面成功或失敗都執行 |
| `never` | 不加入 pipeline |
| `delayed` | 搭配 `start_in`，延遲一段時間後執行 |

測試連不到 service 的資料庫時：

| 現象 / 訊息 | 原因 | 怎麼處理 |
|---|---|---|
| `could not translate host name "postgres" to address` | job 沒有 `services:`，或連線用的主機名稱和 service 的名稱 / alias 不一致 | 加上 service，主機名稱用 alias（或 image 名稱，如 `postgres`） |

:::stop 讀到這裡可以先停：會讀寫 stages、needs、rules，把測試、build、手動部署拆成各自的 job。後面的 stage 時間線、預定義變數與 MR pipeline，在 job 沒有照預期出現時回來讀；Runner、protected 與 masked 變數、Container Registry 與手動部署，在要自己架 Runner 或接上正式環境部署時再讀。

## artifacts 與 cache 的差別、SSH 主機金鑰

- 用 `artifacts` 傳 build 產物。`cache` 只加速下載，不保證存在，各 Runner 預設也不共用。
- `StrictHostKeyChecking=yes` 要先提供 `known_hosts`（例如 File 型變數），用它驗證部署主機。

## 執行順序：stages 的時間線與 needs

範例在 main 分支上的時間線：

| 時間 | test stage | build stage | deploy stage |
|---|---|---|---|
| t0 | `lint`、`test` 同時開始 | 等待 | 等待 |
| t1 | `lint` 完成，`test` 還在跑 | 等待（要等整個 test stage） | 等待 |
| t2 | `test` 完成 | `build-image` 開始 | 等待 |
| t3 | | `build-image` 完成 | `deploy-production` 出現「手動執行」按鈕 |

- `needs` 按 DAG 依賴開跑，預設只下載列出的 job 的 artifacts。`needs: []` 在 pipeline 開始時就跑。

## rules 常用的預定義變數、MR pipeline 與分支 pipeline

| 變數 | 內容 | 注意 |
|---|---|---|
| `CI_PIPELINE_SOURCE` | 觸發來源：`push`、`merge_request_event`、`schedule`、`web` 等 | 判斷是否為 MR pipeline 就靠它 |
| `CI_COMMIT_BRANCH` | 分支名稱 | **MR pipeline 裡沒有這個變數**；要用 `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` |
| `CI_DEFAULT_BRANCH` | 專案的預設分支，通常是 `main` | 比寫死 `"main"` 好，改名時不用改每個檔案 |
| `CI_COMMIT_TAG` | tag 名稱 | 只有 tag pipeline 才有 |
| `CI_COMMIT_SHORT_SHA` | commit 的前 8 個字元 | 拿來當 image tag，正式環境就能對回 commit |
| `CI_REGISTRY_IMAGE` | 這個專案在 Container Registry 的 image 路徑 | 例如 `gitlab.example.org:5050/infra/booking` |

舊版的 `only` / `except` 仍然能用，但官方建議改用 `rules`；兩者不能在同一個 job 混用。

### MR pipeline 與分支 pipeline

分支有開啟的 MR 時，同一次 push 可能各觸發一次分支和 MR pipeline（`CI_PIPELINE_SOURCE == "merge_request_event"`）。範例的 `workflow: rules` 在有 MR 時只跑 MR pipeline，否則跑分支 pipeline。

在 Merge requests 設定勾選「Pipelines must succeed」，要求 MR 通過 pipeline 才能合併。

## Runner：job 真正在哪裡執行

GitLab 排程並記錄，GitLab Runner 輪詢並執行 job。

### 範圍

| 範圍 | 誰能用 | 常見用途 |
|---|---|---|
| instance runner（舊稱 shared runner） | 整個 GitLab 的所有專案 | 一般的 lint、測試 |
| group runner | 某個群組底下的專案 | 部門共用、需要特定網路位置的 Runner |
| project runner | 指定的專案 | 部署用、能連到正式環境的 Runner |

將能連正式環境、持有部署權限的 Runner 設成 protected，只接受保護分支或 tag 的 job。

### executor

| executor | 怎麼執行 | 取捨 |
|---|---|---|
| shell | 直接在 Runner 主機上用 shell 執行 | 最簡單；job 之間共用環境、互相影響，不建議給多個專案共用 |
| docker | 每個 job 起一個新容器（`image:`），`services:` 也是容器 | 環境乾淨、可重現；最常見 |
| kubernetes | 每個 job 在叢集裡建一個 Pod | 能隨叢集擴展；導入 Kubernetes 後的自然選擇 |
| 其他 | ssh、VirtualBox、Parallels、custom、instance 等 | 特殊需求 |

`image:` 和 `services:` 只在 docker、kubernetes 這類容器型 executor 有作用；shell executor 會忽略它們。

job 的 `tags: [prod-network]` 會選有相符標籤的 Runner。新版先在 GitLab 建立 Runner，取得 `glrt-` authentication token，再執行 `gitlab-runner register`。舊的 registration token 已棄用。

Runner 要能連 GitLab、套件來源、registry 和部署主機。內網的 `pip install` 或 `docker pull` 逾時時，查 proxy 或內部鏡像，見 [網路通不通](#/skill/network-troubleshooting)。

## 變數與機密：protected、masked

變數可以寫在 `.gitlab-ci.yml`，也可以設在專案、群組、instance 的 **Settings → CI/CD → Variables**。機密只能放在後者，並視需要勾選：

| 選項 | 效果 | 防的是什麼 |
|---|---|---|
| Protected | 只注入**受保護分支或受保護 tag** 上的 pipeline | 有人在自己的分支改 `.gitlab-ci.yml`，把變數 `echo` 出來或傳到別處 |
| Masked | 值出現在 job log 時顯示成 `[MASKED]` | 不小心在 log 裡印出機密 |
| Masked and hidden（專案與群組變數 GitLab 17.4 起，17.6 正式提供） | 除了遮蔽，建立後在設定頁面上也看不到值 | 有專案設定權限的人看到值 |
| File 型 | 值寫進一個暫存檔，變數內容是檔案路徑 | SSH 金鑰、kubeconfig 這類工具要求以檔案提供的機密 |

Masked 值須為單行、無空格且至少 8 字元。開啟「Expand variable reference」時另有限制。GitLab 18.3 起新增變數預設為 Masked（2026 年 11 月核對，自架版看對應文件）。

在 Settings → Repository → Protected branches 設定 push、合併與 force push 權限，供 protected 變數、Runner 使用。Masked 只遮蔽 log 的原始值，編碼後或寫入 artifact 仍會洩漏。部署金鑰應限制在受保護 ref 使用。

GitLab 也會自動提供一些不用自己設定的機密，例如 `CI_JOB_TOKEN`（這個 job 的短期權杖）、`CI_REGISTRY_PASSWORD`（登入本專案 Container Registry 用）。它們只在 job 執行期間有效。

## GitLab Container Registry

每個 GitLab 專案可以有自己的 container registry（自架的 GitLab 需要管理員先啟用）。在 job 裡用預定義變數登入與推送：

```bash
echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA" .
docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"
```

- `--password-stdin` 可讓密碼避開程序列表與指令紀錄。
- staging 驗過的固定 tag 直接部署到 production，便於追查與回退。見 [環境、secrets 與 artifact](#/skill/environments-secrets)。
- 在 Settings → Packages and registries 設定清理政策，移除累積的舊映像。

`docker:dind` 需要 privileged Runner。共用 Runner 時評估主機權限，或選不需 privileged 的工具如 Buildah。

## environments 與手動部署

加 `environment:` 後，Operate → Environments 會記錄 commit、觸發者和時間。部署使用固定 image tag 時，可從歷史重新部署以回退。

- `when: manual`：寫在 `rules` 裡的 manual job，預設不允許失敗（`allow_failure: false`），pipeline 會停在等待狀態，直到有人執行。
- `resource_group`：同一個 resource group 的 job 一次只跑一個，避免兩條 pipeline 同時部署到 production。
- **Protected environments** 和部署核准屬 GitLab Premium、Ultimate，採用前查官方功能表。免費版可以用 protected 變數加受保護分支限制部署，執行該分支手動 job 的人還需要合併權限。

把 MR 核准、pipeline 和部署歷史串起來當稽核證據，見 [受監管環境的變更管理](#/skill/change-management)。

## 與 GitHub Actions 對照

| GitLab CI | GitHub Actions |
|---|---|
| pipeline | workflow run |
| `script:` | `steps:` 裡的 `run:` |
| Runner（instance / group / project） | runner（GitHub-hosted / self-hosted） |

檔案、觸發條件、執行順序、機密、`services:` 與 registry 的對照見 [CI 管線：lint、test、build](#/skill/ci-pipeline)。

## 常見錯誤與錯誤訊息

| 現象 / 訊息 | 原因 | 怎麼處理 |
|---|---|---|
| job 一直 pending，提示沒有可用的 Runner | 沒有線上的 Runner 符合 job 的 `tags`；或 Runner 是 protected，而這是非受保護分支 | 檢查 job 的 `tags` 與 Runner 的標籤、Runner 的 protected 設定 |
| 變數在 main 有值、在功能分支是空的 | 變數設成 protected，功能分支不是受保護分支 | 這通常是預期行為；功能分支不該拿到正式環境機密 |
| 連 `localhost:5432` 被拒絕 | docker executor 下 service 是另一個容器，不在 localhost | 改用 service 的主機名稱（Kubernetes executor 下 service 與 job 在同一個 Pod，才能用 localhost） |
| `Cannot connect to the Docker daemon at tcp://docker:2375. Is the docker daemon running?` | 沒有 `docker:dind` service、TLS 設定不一致，或 Runner 沒開 privileged | 加上 dind service 與 `DOCKER_TLS_CERTDIR`，確認 Runner 設定 |
| `docker push` 回 `denied: access forbidden` | 沒有登入 registry，或推到不屬於這個專案的路徑 | 確認 `docker login` 在 push 之前、tag 用 `$CI_REGISTRY_IMAGE` 開頭 |
| pipeline 建立失敗，訊息說沒有任何 stage / job | `rules` 把所有 job 都排除了 | 檢查 `workflow: rules` 與各 job 的 `rules`；在 MR pipeline 裡 `CI_COMMIT_BRANCH` 是空的 |
| YAML 錯誤，例如 `jobs:test config contains unknown keys: scripts` | 關鍵字拼錯、縮排錯 | 用 GitLab 的 pipeline editor（Build → Pipeline editor）先驗證 |

## 動手

1. 到本課的程式題，依序完成：讓測試用 PostgreSQL service、把 image 推到 `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA`、讓部署只在 main 手動執行並移除寫死的機密。
2. 在一個測試專案裡，把 main 設成受保護分支，建立一個 protected、masked 的變數，分別在 main 與功能分支的 job 裡執行 `echo "$MY_SECRET"`，比較兩邊的 log。
3. 把範例的 `deploy-production` 改成先部署到 `staging` 環境（自動），再部署到 `production`（手動），兩個 job 用同一個 image tag。
