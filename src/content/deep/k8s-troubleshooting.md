## `kubectl get pods` 一排紅字

週一早上部署完新版，`kubectl get pods -n booking` 的輸出類似這樣：

```bash
$ kubectl get pods -n booking
NAME                              READY   STATUS             RESTARTS      AGE
booking-api-6b8f7c9d54-4xk2p      1/1     Running            0             3d
booking-api-7c5d9f8b66-h2m8q      0/1     CrashLoopBackOff   5 (40s ago)   4m
booking-web-58c9d7f6b4-kk2x8      0/1     ImagePullBackOff   0             4m
report-worker-7f6d4c8b9-p0c3a     0/1     Pending            0             4m
notify-api-5d8c7b6f44-w9r2t       1/1     Running            12 (3m ago)   2h
export-api-84f9d6c5b7-m4n1z       1/1     Running            0             1h
```

六個 Pod、六種狀況：一個正常、一個啟動就掛、一個拉不到映像、一個排不上節點、一個看起來正常但重啟了 12 次。最後那個 `export-api` 狀態全綠，但使用者說連不到。

看到紅字就 `kubectl delete pod` 或把 Deployment 刪掉重建沒有用：Pod 是 Deployment 依範本建出來的，範本沒改，重建出來的 Pod 會停在一樣的狀態，前一次的 log 與事件也跟著消失。

## 固定的排查順序：get、describe、logs、events

不管是哪一種狀態，都照同一個順序往下查：

| 步驟 | 指令 | 回答的問題 |
|---|---|---|
| 1 | `kubectl get pods -n <ns> -o wide` | 哪些 Pod 有問題？STATUS、READY、RESTARTS 各是多少？在哪個節點？ |
| 2 | `kubectl describe pod <pod> -n <ns>` | Kubernetes 對這個 Pod 做了什麼？看最下面的 Events，以及容器的 State 與 Last State |
| 3 | `kubectl logs <pod> -n <ns>`（必要時加 `--previous`） | 程式自己說了什麼？ |
| 4 | `kubectl get events -n <ns> --sort-by=.lastTimestamp` | 這個 namespace 最近還發生了什麼？（Pod 已經不在時也查得到） |

Events 是 Kubernetes 的視角（排程、拉映像、探針、重啟），logs 是應用程式的視角（stdout 與 stderr）。容器沒啟動過（Pending、ImagePullBackOff）時沒有 log，只能看 Events；程式啟動後自己掛掉時，Events 只說「它結束了」，原因在 log 裡。

兩個欄位要和 STATUS 一起看：

- **READY** 是「ready 的容器數 / 容器總數」。`Running` 但 `0/1` 表示容器在跑、但 readiness 沒通過，Service 不會送流量給它。
- **RESTARTS** 不是 0 就值得查，即使現在是 `Running`。`notify-api` 兩小時重啟 12 次，每次重啟都有進行中的請求被切斷。

## 每一種狀態先看哪裡

| 狀態 | 意思 | 先看 |
|---|---|---|
| `Pending` | 排程器找不到可以放它的節點 | `describe pod` 的 Events：`FailedScheduling` 列出每類節點被排除的原因 |
| `ErrImagePull`、`ImagePullBackOff` | 拉不到映像 | Events 的 `Failed`：registry 回的錯誤 |
| `CreateContainerConfigError` | `env` 參照的 ConfigMap 或 Secret 不存在 | Events（沒有 log） |
| `CrashLoopBackOff` | 容器啟動後程序結束，正在等下一次重啟 | `logs --previous` 與 `Last State` 的 Exit Code |
| `Reason: OOMKilled`、Exit Code 137 | 記憶體超過 limits，程式來不及寫 log | `describe pod` 的 `Last State` |
| `Running` 但 `READY 0/1` | readiness 沒通過 | Events 的 `Readiness probe failed` |
| `Running`、`1/1` 但連不到 | Service 的 selector、`targetPort` 或 NetworkPolicy | `kubectl get endpointslices` 看 Service 後面有沒有 Pod |

`CrashLoopBackOff` 時 `kubectl logs <pod>` 看到的是**剛啟動的這一次**，常常是空的，要加 `--previous` 看上一次：

```bash
kubectl logs booking-api-7c5d9f8b66-h2m8q -n booking --previous
kubectl describe pod booking-api-7c5d9f8b66-h2m8q -n booking
```

:::stop 讀到這裡可以先停：會照 get、describe、logs、events 的順序，從 Pod 的狀態找到下一個指令。後面每一種狀態各有一章，列出訊息關鍵字、原因與下一步，遇到那個狀態時回來查；模擬程式與 exec、port-forward、debug，在線索不夠、要進到容器裡查時再讀。

## Pending：排不上節點

Events 的 `FailedScheduling` 訊息類似：

```text
Warning  FailedScheduling  default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient memory.
```

| 訊息裡的關鍵字 | 原因 | 下一步 |
|---|---|---|
| `Insufficient cpu`、`Insufficient memory` | 節點上「還沒被保留」的資源，放不下這個 Pod 的 **requests**（與節點的實際使用率無關） | `kubectl describe node <node>` 看 Allocated resources；調低過大的 requests、縮減其他工作負載，或加節點 |
| `untolerated taint`（舊版的寫法是 `had taint … that the pod didn't tolerate`） | 節點有 taint，Pod 沒有對應的 toleration | 確認是不是本來就不該排到那些節點；可用的節點是否太少 |
| `didn't match Pod's node affinity/selector` | `nodeSelector` 或 affinity 指定的 label，沒有節點符合 | `kubectl get nodes --show-labels` 對照 |
| `unbound immediate PersistentVolumeClaims` | Pod 要用的 PVC 還沒綁定到 PV | `kubectl get pvc -n <ns>`、`kubectl describe pvc`：StorageClass 不存在或沒有預設的 StorageClass |

副本不足又看不到 Pending 的 Pod 時，用 `kubectl describe replicaset` 查 ReplicaSet Events。namespace 的 ResourceQuota 用完時，Pod 建不出來。

## ImagePullBackOff 與 ErrImagePull：拉不到映像

`ErrImagePull` 表示剛拉取失敗，`ImagePullBackOff` 表示正在等下一次重試，間隔會逐漸拉長。

| 訊息裡的關鍵字 | 原因 | 下一步 |
|---|---|---|
| `not found`、`manifest unknown` | 映像名稱或 tag 打錯；CI 還沒把這個 tag 推上去 | 到 registry 確認這個 tag 存在；對照 manifest 的 `image` |
| `unauthorized`、`authentication required`、`pull access denied` | 私有倉庫，Pod 沒有帶登入資訊 | 建立 `kubernetes.io/dockerconfigjson` 型別的 Secret，在 Pod 的 `imagePullSecrets` 參照它（Secret 要在同一個 namespace） |
| `x509: certificate signed by unknown authority` | 節點不信任 registry 的憑證 | 內部 CA 的根憑證要裝在每個節點上，見 [導入 Kubernetes 前要準備什麼](#/skill/k8s-readiness) |
| `i/o timeout`、`no such host` | 節點連不到 registry | 從節點檢查 DNS 與防火牆，見 [網路通不通：從 DNS 到防火牆](#/skill/network-troubleshooting) |

節點上的容器執行環境負責拉映像，在本機跑 `docker pull` 成功只代表本機能存取。

## CrashLoopBackOff：啟動後一直結束

kubectl 的 STATUS 是摘要。`CrashLoopBackOff` 與 `ImagePullBackOff` 都是容器等待的原因。kubelet 預設每次重啟前的等待時間加倍，從 10 秒到最多 5 分鐘。

`describe` 裡容器的 `Last State` 類似：

```text
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
      Started:      Mon, 09 Nov 2026 09:12:41 +0800
      Finished:     Mon, 09 Nov 2026 09:12:43 +0800
    Restart Count:  5
```

| 線索 | 多半是 | 下一步 |
|---|---|---|
| Exit Code 1（或其他非零值），啟動後幾秒就結束 | 程式啟動時丟出例外：必要的環境變數沒給、連不上資料庫、migration 沒跑 | `logs --previous` 的最後幾行通常就是原因 |
| Exit Code 127 或 126；或 `Reason: StartError`、訊息有 `executable file not found` | 啟動指令找不到，或沒有執行權限 | 檢查映像的 `ENTRYPOINT`、`CMD` 與 manifest 的 `command`、`args` |
| Exit Code 0，卻一直重啟 | 程式做完事就正常結束了；Deployment 預期的是不會結束的服務 | 一次性的工作改用 Job 或 CronJob |
| `Reason: OOMKilled`、Exit Code 137 | 記憶體超過 limits（見 OOMKilled 那一章） | 不要只看 CrashLoopBackOff 就當成程式錯誤 |
| Events 有 `Liveness probe failed`，接著 `will be restarted` | 是 kubelet 把它殺掉的：liveness 在啟動完成前就判定失敗，或 liveness 檢查了外部依賴 | 加 `startupProbe`；liveness 只檢查程序本身 |

結束碼大於 128 時，減掉 128 是訊號的編號：137 是 SIGKILL（9），143 是 SIGTERM（15）。

## OOMKilled：記憶體超過 limits

核心殺掉容器時，log 通常沒有線索。137 代表 SIGKILL，要看見 `Reason: OOMKilled` 才能確認。用量在啟動或尖峰時穩定超過 limits，就調整 limits 與 requests。用量持續上升時，查程式是否有記憶體洩漏。

`kubectl top pod -n <ns>` 需要 metrics-server，只顯示當下用量。查趨勢用監控歷史曲線，見 [硬體資源與容量規劃](#/skill/capacity-planning)。

`Evicted` 表示節點記憶體或磁碟不足，kubelet 驅逐了 Pod。用 `describe pod` 查 Message。

## Running，但 Service 連不到

Pod 是 `Running`，其他服務連 `http://export-api` 卻不通。從 Service 往 Pod 一層一層查：

```bash
# 1. Service 後面有沒有 Pod
kubectl get endpointslices -n booking -l kubernetes.io/service-name=export-api

# 2. Service 的 selector 與 port
kubectl describe service export-api -n booking

# 3. 拿 selector 去找 Pod，並列出 label 與 READY
kubectl get pods -n booking -l app=export-api --show-labels -o wide
```

| 查到的結果 | 原因 | 下一步 |
|---|---|---|
| ENDPOINTS 是空的，第 3 步也找不到 Pod | selector 與 Pod 的 label 對不上，或兩者不在同一個 namespace | 對照 Service 的 `selector` 與 Deployment 的 `template.metadata.labels` |
| ENDPOINTS 是空的，第 3 步找得到 Pod 但 `READY 0/1` | readiness 沒通過 | `describe pod` 看 `Readiness probe failed` 的訊息 |
| ENDPOINTS 有位址，連線被拒絕（connection refused） | `targetPort` 不是程式監聽的 port；或程式只監聽 `127.0.0.1` | 對照 `targetPort` 與程式實際監聽的位址和 port；容器裡的服務要監聽 `0.0.0.0` |
| ENDPOINTS 有位址，連線逾時（timeout） | NetworkPolicy 擋住，或節點之間的網路問題 | `kubectl get networkpolicy -n <ns>`；確認來源 Pod 在允許的範圍內 |
| 名稱解析失敗 | 跨 namespace 卻只寫了短名稱；或 NetworkPolicy 擋住了 DNS | 改用 `<service>.<namespace>`；檢查對外規則有沒有放行 DNS（port 53） |

連線被拒絕或逾時的判讀見 [網路通不通：從 DNS 到防火牆](#/skill/network-troubleshooting)。叢集網路外掛支援 NetworkPolicy 時，policy 選到的 Pod 只允許規則放行的流量。

## Ingress 回 404、502、503、504

狀態碼是 Ingress controller 產生的，下面是 nginx 系 controller 的常見對應，其他 controller 的行為可能略有不同：

| 狀態碼 | 意思 | 下一步 |
|---|---|---|
| 404 | 請求的 Host 或路徑沒有對到任何規則；或這份 Ingress 根本沒被 controller 處理 | 檢查 `host`、`path`、`pathType` 與 `ingressClassName`；用 `curl -H "Host: …"` 確認送出去的 Host |
| 503 | 規則對到了，但 Service 後面沒有可用的 Pod | 回到「Running，但 Service 連不到」那一章，從 EndpointSlice 查起 |
| 502 | controller 連到了 Pod，但連線被拒絕或回應壞掉 | `targetPort` 寫錯、Pod 正在重啟、後端是 HTTPS 而 controller 用 HTTP 連 |
| 504 | 後端太久沒有回應 | 程式本身慢，或 controller 的逾時設定太短 |

用 `port-forward` 直接連 Service 或 Pod，確認後端能否回應，再查 Ingress、外部負載平衡器、DNS 與憑證，見 [網路通不通：從 DNS 到防火牆](#/skill/network-troubleshooting)。探針、requests、selector 的設定見 [Kubernetes manifest](#/skill/k8s-manifests) 與 [設定、探針與資源](#/skill/k8s-config-probes)。

## 用程式走一遍排查順序

範例把開頭六個 Pod 的狀態、上次結束資訊與 Events 整理成資料。

```python run
pods = [
    {"name": "booking-api-4xk2p", "phase": "Running", "ready": True, "restarts": 0,
     "waiting": None, "last_reason": None, "exit_code": None, "events": []},
    {"name": "booking-api-h2m8q", "phase": "Running", "ready": False, "restarts": 5,
     "waiting": "CrashLoopBackOff", "last_reason": "Error", "exit_code": 1,
     "events": [("BackOff", "Back-off restarting failed container api")]},
    {"name": "booking-web-kk2x8", "phase": "Pending", "ready": False, "restarts": 0,
     "waiting": "ImagePullBackOff", "last_reason": None, "exit_code": None,
     "events": [("Failed", "Failed to pull image \"registry.example.org/booking/web:3f9c2a1\": not found")]},
    {"name": "report-worker-p0c3a", "phase": "Pending", "ready": False, "restarts": 0,
     "waiting": None, "last_reason": None, "exit_code": None,
     "events": [("FailedScheduling", "0/3 nodes are available: 3 Insufficient memory.")]},
    {"name": "notify-api-w9r2t", "phase": "Running", "ready": True, "restarts": 12,
     "waiting": None, "last_reason": "OOMKilled", "exit_code": 137, "events": []},
    {"name": "export-api-m4n1z", "phase": "Running", "ready": True, "restarts": 0,
     "waiting": None, "last_reason": None, "exit_code": None, "events": [],
     "labels": {"app": "export-api"}, "port": 8000},
]

def diagnose(pod):
    msgs = " ".join(m for _, m in pod["events"])
    # 1. 上一次怎麼結束的：OOMKilled 要先判斷，因為它的 STATUS 也可能是 CrashLoopBackOff 或 Running
    if pod["last_reason"] == "OOMKilled":
        return "記憶體超過 limits", "看記憶體曲線：穩定偏高就調 limits，一路上升就是洩漏"
    # 2. 還沒排上節點
    if pod["phase"] == "Pending" and pod["waiting"] is None:
        if "PersistentVolumeClaim" in msgs:
            return "PVC 沒有綁定", "kubectl describe pvc，檢查 StorageClass"
        if "Insufficient" in msgs:
            return "節點資源放不下 requests", "kubectl describe node 看已分配的資源；調 requests 或加節點"
        return "沒有符合條件的節點", "檢查 taint、nodeSelector、affinity"
    # 3. 容器在等待
    if pod["waiting"] in ("ImagePullBackOff", "ErrImagePull"):
        if "unauthorized" in msgs or "denied" in msgs:
            return "私有倉庫沒有登入資訊", "建立 imagePullSecrets"
        return "映像名稱或 tag 不存在", "到 registry 確認 tag；對照 manifest 的 image"
    if pod["waiting"] == "CreateContainerConfigError":
        return "參照的 ConfigMap 或 Secret 不存在", "看 Events 指出缺哪一個"
    if pod["waiting"] == "CrashLoopBackOff":
        if "Liveness probe failed" in msgs:
            return "被 liveness 探針重啟", "加 startupProbe；liveness 不要檢查外部依賴"
        return f"程式啟動後就結束（exit code {pod['exit_code']}）", "kubectl logs --previous 看上一次的輸出"
    # 4. 在跑，但沒有 ready
    if pod["phase"] == "Running" and not pod["ready"]:
        return "readiness 沒通過，Service 不會送流量給它", "describe pod 看探針失敗的訊息，再看程式的 log"
    return "正常", "—"

for pod in pods:
    cause, action = diagnose(pod)
    status = pod["waiting"] or pod["phase"]
    print(f"{pod['name']:<22} {status:<17} 重啟 {pod['restarts']:>2} 次")
    print(f"    原因：{cause}")
    print(f"    下一步：{action}")

# Pod 正常但連不到：換查 Service 這一層
def check_service(svc, pods):
    matched = [p for p in pods if all(p.get("labels", {}).get(k) == v for k, v in svc["selector"].items())]
    if not matched:
        return "selector 選不到任何 Pod，endpoints 是空的", "對照 Service 的 selector 與 Pod 的 label"
    if not any(p["ready"] for p in matched):
        return "選到的 Pod 都沒有 ready，endpoints 是空的", "查 readiness 探針"
    if any(p["port"] != svc["target_port"] for p in matched):
        return "targetPort 不是容器監聽的 port", "對照 targetPort 與程式監聽的 port"
    return "Service 這一層正常", "往 NetworkPolicy 與 Ingress 查"

service = {"name": "export-api", "selector": {"app": "export_api"}, "target_port": 8000}
cause, action = check_service(service, pods)
print(f"\nService {service['name']}（selector = {service['selector']}）")
print(f"    原因：{cause}")
print(f"    下一步：{action}")
```

`notify-api` 是 `Running`、`READY 1/1`，上一次結束原因仍指出故障。`export-api` 的 Pod 正常，問題在 Service selector。

## 進到容器裡查：exec、port-forward、debug

| 指令 | 用途 | 限制 |
|---|---|---|
| `kubectl exec -it <pod> -n <ns> -- sh` | 在**執行中的容器**裡開 shell 或執行指令：看環境變數、看掛載的檔案、從 Pod 的位置測連線 | 容器要在執行中（CrashLoopBackOff 時進不去）；映像裡要有 shell 與需要的工具 |
| `kubectl port-forward <pod 或 service/名稱> 8080:80 -n <ns>` | 把本機的 port 接到 Pod 或 Service，跳過 Ingress 直接測 | 只用於除錯；指定 Service 時實際只連到其中一個 Pod |
| `kubectl debug -it <pod> --image=busybox:1.36 --target=<容器名稱> -n <ns>` | 在 Pod 裡加一個臨時容器（ephemeral container），共用它的網路，帶自己的工具 | 需要叢集支援並允許臨時容器；臨時容器加上去後要等 Pod 刪除才會消失 |
| `kubectl debug node/<node> -it --image=busybox:1.36` | 在節點上開一個除錯用的 Pod | 權限很大，通常只有叢集管理者能用 |

```bash
# 程式實際拿到的環境變數（會印出秘密，注意畫面與紀錄）
kubectl exec booking-api-6b8f7c9d54-4xk2p -n booking -- env

# 從 Pod 的位置測另一個 Service：分辨是「這個 Pod 連不到」還是「大家都連不到」
kubectl exec -it booking-api-6b8f7c9d54-4xk2p -n booking -- sh
# 在容器裡（映像要有這些工具；沒有就用 kubectl debug 帶一個有工具的臨時容器）：
#   nslookup export-api.booking.svc.cluster.local
#   wget -qO- http://export-api/healthz

# 跳過 Ingress 與 Service，直接連某一個 Pod
kubectl port-forward pod/export-api-84f9d6c5b7-m4n1z 8080:8000 -n booking
```

正式映像可能沒有 shell 或 `curl`，見 [幫 Python 專案寫好 Dockerfile](#/skill/dockerfile-python)。使用 `debug` 帶工具，讓 `exec` 與 `debug` 都受 RBAC 管控並留下稽核紀錄。容器內的修改會隨 Pod 重建消失。

## 常見錯誤與錯誤訊息

訊息依 Kubernetes 版本而異。

| 訊息或現象 | 意思 | 下一步 |
|---|---|---|
| `previous terminated container "api" in pod "…" not found` | 加了 `--previous`，但這個容器沒有上一次 | 容器沒重啟過，或 Pod 已經被重建；拿掉 `--previous`，或查 log 收集系統 |
| `container "api" in pod "…" is waiting to start: ContainerCreating` | 容器還沒啟動，沒有 log | 看 `describe pod` 的 Events |
| `error: deployment "booking-api" exceeded its progress deadline` | 滾動更新太久沒有進展 | 找出新的 ReplicaSet 的 Pod，照本課的順序查 |
| `Error from server (Forbidden): pods "…" is forbidden: User "…" cannot get resource "pods/log"` | 帳號的 RBAC 權限不足 | 不是 Pod 的問題；找叢集管理者確認權限 |
| 刪掉 Pod 之後好了一陣子又壞 | 重建只是把狀態歸零（例如記憶體洩漏重新累積） | 回頭查 `RESTARTS` 與 `Last State`，找出根本原因 |

Events 預設只保留一小時左右。事故發生後要盡快看，或靠叢集的監控與 log 收集保留下來（見 [可觀測性：log、metrics、trace](#/skill/observability)）。

事故當下的分工與紀錄方式，見 [事故處理、on-call 與 postmortem](#/skill/incident-response)。

## 動手

1. 在診斷程式加三個 Pod，分別模擬 liveness probe 失敗、PVC 未綁定、Running 但未就緒。先預測結果再執行，接著修正 Service 的 selector 並重跑。
2. 做本課的程式題：實作 `diagnose(pod)`，把狀態、結束碼與 Events 分類成固定的原因代碼。
3. 到 [Kubernetes 排錯實驗室](#/lab/K8sDebugLab)練六種故障情境，再依 [本機叢集指南](https://github.com/yo02741/u-kinda-should-know/blob/main/companion/clinic-api/docs/local-k8s.md)的「故意弄壞」實測，整理出含 namespace、registry 與監控位置的 runbook。
4. 各環境反覆出現相同設定錯誤時，讀 [Helm、Kustomize 與 GitOps](#/skill/k8s-helm-gitops)。
