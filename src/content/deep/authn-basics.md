## 登出了，卻還登入著：存在 localStorage 的 7 天 JWT

一個電商網站的 SPA 登入後拿到效期 7 天的 JWT，存在 `localStorage`，每個請求帶 `Authorization: Bearer …`。一位使用者在網咖登入後忘了登出，回家改了密碼、按了「登出所有裝置」，隔天還是有人用他的帳號下單。

- 「登出」只是前端刪掉 `localStorage` 裡的 token，網咖那台的 token 沒人刪。
- 「改密碼」更新了密碼雜湊，但伺服器驗 JWT 只檢查簽章與 `exp`，不查資料庫。
- 「登出所有裝置」的 API 什麼也沒做：伺服器沒有「目前有哪些登入」的紀錄可以刪。

改用伺服器端 session，刪掉這位使用者的所有 session 紀錄，網咖那台的下一個請求就被擋下。

## 登入狀態存在哪、怎麼帶：兩個獨立的選擇

HTTP 每個請求彼此獨立。登入成功時伺服器發一個憑證給客戶端，之後每個請求帶著它。憑證有兩種形態：

- **參照（reference）**：一個隨機字串，伺服器拿它去查表才知道是誰。
- **自帶（self-contained）**：憑證裡直接寫著「我是 u_42、幾點到期」，加上簽章防竄改。JWT 是最常見的格式。

怎麼帶是另一個維度：

| | cookie（瀏覽器自動帶） | `Authorization` header（程式自己帶） |
|---|---|---|
| 參照型（查表） | 傳統 session | opaque token |
| 自帶型（驗簽章） | JWT 放在 cookie 裡 | 常見的「JWT 登入」 |

撤銷能力取決於查不查表；CSRF 與 XSS 風險取決於怎麼帶、存在哪。

## cookie session 與 token 的登入往返，以及各自怎麼撤銷

cookie session：伺服器收到登入表單後做四件事。

1. 用 email 找到使用者，比對密碼雜湊（見 [密碼儲存](#/skill/password-storage)）。
2. 用密碼學亂數產生一個**新的** session id。
3. 在共用儲存（Redis 或資料庫）寫一筆 `session_id → { user_id, expires_at, … }`。
4. 用 `Set-Cookie` 把 session id 交給瀏覽器。

```http
HTTP/1.1 303 See Other
Location: /account
Set-Cookie: __Host-sid=q7HkX2vP9mT4sL8wR1yZ3cF6hJ0dN5gA; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1209600
```

之後瀏覽器每個請求自動帶上這個 cookie，伺服器拿它查表，查不到或過期就回 401。`HttpOnly` 讓 JavaScript 讀不到 cookie，`Secure` 只在 HTTPS 送出，`SameSite=Lax` 讓別的網站發起的子請求不帶它。

token：登入回應的 body 裡有兩個 token，客戶端自己把 access token 放進 `Authorization` header。

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{"access_token": "eyJhbGciOiJSUzI1NiIs…", "token_type": "Bearer", "expires_in": 900, "refresh_token": "rt_8Yw2…"}
```

access token 是 JWT 時，伺服器驗簽章與 `exp` 就知道是誰，不必查表。到期後客戶端用 refresh token 換新的；refresh token 存在伺服器端、可以撤銷。

| 情境 | session（查表） | 自帶型 JWT（不查表） |
|---|---|---|
| 登出所有裝置 | 刪掉該使用者的所有 session | 撤銷所有 refresh token；access token 撐到過期 |
| 失效延遲 | 0 | 最長等於 access token 的效期（常見 5～15 分鐘） |

開頭的事故是右欄最差的組合：7 天效期、沒有 refresh 這一層。

## 查表與驗簽章的程式比較，以及兩個最常見的錯誤

session 存在字典裡；token 用 HMAC 簽一個「使用者 + 到期時間」的字串（概念和 HS256 JWT 一樣，格式簡化）。

```python run
import hmac, hashlib, secrets, base64, json

SECRET = b"server-side-secret-demo"
NOW = 1_000_000           # 固定的「現在」，單位秒

# ---------- 做法一：伺服器端 session ----------
sessions = {}             # session_id -> {user, expires}

def login_session(user):
    sid = secrets.token_urlsafe(32)                 # 256 bits 隨機，本身沒有意義
    sessions[sid] = {"user": user, "expires": NOW + 14 * 86400}
    return sid

def check_session(sid, now):
    s = sessions.get(sid)                           # 每個請求查一次表
    if s is None or now >= s["expires"]:
        return None
    return s["user"]

def logout_all_sessions(user):
    for sid in [k for k, v in sessions.items() if v["user"] == user]:
        del sessions[sid]

# ---------- 做法二：自帶型 token（HMAC 簽章，不查表） ----------
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def unb64(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def issue_token(user, ttl):
    body = b64(json.dumps({"sub": user, "exp": NOW + ttl}).encode())
    sig = b64(hmac.new(SECRET, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"

def check_token(token, now):
    body, sig = token.split(".")
    expected = b64(hmac.new(SECRET, body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):      # 常數時間比較
        return None
    claims = json.loads(unb64(body))
    if now >= claims["exp"]:
        return None
    return claims["sub"]                            # 完全沒查任何表

# 網咖那台電腦拿到的憑證
cafe_sid = login_session("alice")
cafe_token = issue_token("alice", ttl=7 * 86400)

print("登出所有裝置之前：")
print("  session →", check_session(cafe_sid, NOW + 60))
print("  token   →", check_token(cafe_token, NOW + 60))

logout_all_sessions("alice")                        # 刪得掉 session；token 沒有東西可刪

print("登出所有裝置之後（一小時後）：")
print("  session →", check_session(cafe_sid, NOW + 3600))
print("  token   →", check_token(cafe_token, NOW + 3600), "← 還有效，直到 exp")
print("  token 8 天後 →", check_token(cafe_token, NOW + 8 * 86400))

# 竄改：把 sub 改成 bob、沿用舊簽章
body, sig = cafe_token.split(".")
forged = b64(json.dumps({"sub": "bob", "exp": NOW + 7 * 86400}).encode()) + "." + sig
print("竄改後的 token →", check_token(forged, NOW + 60))
```

- **登入成功，下一個請求又變成未登入**：`Set-Cookie` 被瀏覽器拒收。DevTools 的 Network 面板會在該 cookie 旁標出原因。
- **改密碼後，其他裝置仍然登入著**：改密碼流程沒有撤銷既有的 session 或 refresh token。

:::stop 讀到這裡可以先停：畫得出 cookie session 與 token 兩種登入往返，說得出各自怎麼撤銷，也跑過兩種做法的比較程式。後面是 cookie 屬性的細節、多台伺服器的 session 儲存、CSRF 與 XSS 的攻擊面、各種客戶端的選型，決定專案用哪一種登入方式時再回來讀。

## 驗證與授權的分工

| | 驗證（Authentication，AuthN） | 授權（Authorization，AuthZ） |
|---|---|---|
| 問的問題 | 你是誰？ | 你能做這件事嗎？ |
| 輸入 | 密碼、passkey、OTP、session id、token | 已確認的身分 + 要做的動作 + 目標資源 |
| 失敗時的 HTTP 狀態 | `401 Unauthorized`（名字取得不好，其實是「未驗證」） | `403 Forbidden` |
| 這個領域的課 | 本課、[JWT 解剖](#/skill/jwt)、[API key 與 MFA](#/skill/api-keys-mfa) | [RBAC 與 ABAC](#/skill/rbac-abac)、[驗證授權落地](#/skill/auth-in-practice) |

## 兩種往返的完整請求、cookie 屬性與 session fixation

必讀那張四格表實際帶的東西：

- 傳統 session：`Cookie: sid=…`。
- opaque token：`Authorization: Bearer 3f9a…`，伺服器查表或呼叫 introspection。
- JWT 登入：`Authorization: Bearer eyJ…`；有些框架把 JWT 放在 cookie 裡。

登入表單的請求，以及登入後瀏覽器自動帶 cookie 的請求：

```http
POST /login HTTP/1.1
Host: shop.example.com
Content-Type: application/x-www-form-urlencoded

email=alice%40example.com&password=correct-horse-battery
```

```http
GET /account/orders HTTP/1.1
Host: shop.example.com
Cookie: __Host-sid=q7HkX2vP9mT4sL8wR1yZ3cF6hJ0dN5gA
```

密碼雜湊函式用 Argon2id 或 bcrypt；session 紀錄通常還存 `created_at`、`ip`、`user_agent`。

| 屬性 | 作用 | 少了會怎樣 |
|---|---|---|
| `HttpOnly` | JavaScript 讀不到這個 cookie | 頁面一有 XSS，`document.cookie` 就能把 session id 送走 |
| `Secure` | 只在 HTTPS 送出 | 在 HTTP 連線上以明文傳送，同網路的人可能看到 |
| `SameSite=Lax` | 從別的網站發起的子請求（表單 POST、`fetch`、圖片）不帶這個 cookie；使用者點連結進來的頂層 GET 導覽仍會帶 | CSRF 的主要防線變弱；部分瀏覽器在沒設時預設當 Lax，但不是所有瀏覽器都這樣，不能依賴 |
| `__Host-` 前綴 | 瀏覽器強制要求 `Secure`、`Path=/`、不能設 `Domain` | 子網域可能設下同名 cookie 覆蓋它 |
| `Max-Age` / `Expires` | cookie 在瀏覽器保留多久 | 不設就是「瀏覽器關閉即刪除」的 session cookie；伺服器端的到期仍要另外檢查 |

**登入成功後換一個新的 session id**。如果沿用登入前就存在的 id，攻擊者可以先拿到一個 id、想辦法讓受害者用這個 id 登入，之後攻擊者手上的 id 就變成已登入的（session fixation）。

token 版的登入請求，以及之後帶 token 的請求：

```http
POST /api/login HTTP/1.1
Host: api.example.com
Content-Type: application/json

{"email": "alice@example.com", "password": "correct-horse-battery"}
```

```http
GET /api/orders HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJSUzI1NiIs…
```

JWT 還要檢查 `iss`、`aud`（見 [JWT 解剖](#/skill/jwt)）。實務上的 token 架構幾乎都是「短效的自帶型 access token + 可撤銷的參照型 refresh token」，等於把 session 的撤銷能力放回 refresh 那一層。

撤銷的另外兩種情況：

- 要讓 JWT 的登出立即生效，伺服器得另外記黑名單。
- 停用帳號：session 直接刪掉（登出也是刪掉那一筆，下一個請求立即失效），或每次查表時一併檢查帳號狀態；JWT 要立即生效就得在驗 token 時查帳號狀態，等於又變回查表。

## 多台伺服器時 session 放哪裡

session 的代價是每個請求一次查詢，以及所有應用伺服器都要看得到同一份 session 資料：

- **只放在單一伺服器的記憶體**：多開一台就壞了。負載平衡器把同一個使用者的下一個請求送到另一台，那台不認得這個 session id，使用者被登出。
- **黏著連線（sticky session）**：讓負載平衡器把同一個使用者固定送到同一台。可以動，但那台重啟或縮容時上面的使用者全被登出，負載也不均。
- **共用儲存**：session 放 Redis 或資料庫，所有伺服器都查同一處。這是標準做法。Redis 的單次查詢在同一個資料中心內通常遠低於一毫秒，對大多數服務不是瓶頸。

自帶型 token 不需要共用儲存，任何持有驗證金鑰的服務都能自己驗。這在「很多個獨立服務、甚至不同團隊的服務都要認得同一個使用者」時才真正有價值；單一後端用 JWT 換來的通常只有撤銷上的麻煩。

## 攻擊面：cookie 防 CSRF，header 防 XSS 偷走

| | cookie（HttpOnly） | header（token 存在 JS 讀得到的地方） |
|---|---|---|
| CSRF（跨站請求偽造） | 有風險：瀏覽器會自動帶 cookie，別的網站可以讓瀏覽器對你的網站發請求 | 沒有：別的網站沒辦法讓瀏覽器自動加上你的 Authorization header |
| XSS 偷走憑證 | JS 讀不到，偷不走；但 XSS 仍能在頁面裡以使用者身分發請求 | `localStorage` 或 JS 變數裡的 token 可以被讀出來、送到攻擊者那裡，在任何地方使用到過期 |
| 主要防護 | `SameSite`、CSRF token、檢查 `Origin`、改變狀態的操作不用 GET | 防 XSS（輸出編碼、CSP）、access token 短效期、存在記憶體而非 `localStorage` |

- **HttpOnly 不能讓 XSS 變安全**。它只是讓攻擊者拿不走 session id、不能離開這個頁面使用。頁面上的惡意腳本仍可以直接呼叫 API。XSS 要從根本防，見 [XSS 與 CSRF](#/skill/xss-csrf)。
- **SameSite 看的是「site」不是「origin」**。`evil.shop.example.com` 和 `shop.example.com` 算同一個 site，SameSite 擋不住從同一個註冊網域底下的其他子網域發起的請求。子網域如果開放給使用者或第三方，還是要有 CSRF token 或 `Origin` 檢查。
- **跨網域的 SPA**：前端在 `app.example.com`、API 在 `api.other-domain.com` 時，要帶 cookie 得設 `SameSite=None; Secure` 並處理 CORS 的 credentials，CSRF 風險也回來了。這時通常改用 BFF，或讓 API 與前端同站。CORS 與 cookie 的細節見 [CORS 與 Cookie](#/skill/cors-cookies)。

## 該用哪一種

| 客戶端 | 建議 | 理由 |
|---|---|---|
| 同站的伺服器端渲染網站 | cookie session | 最簡單；瀏覽器自動帶、HttpOnly 防偷、可即時撤銷 |
| SPA，API 與前端同站（同一個網域或子網域） | cookie session（HttpOnly + SameSite + CSRF 防護） | token 不經過 JS，XSS 偷不走；撤銷簡單 |
| SPA，API 在不同網站，或要串第三方身分提供者 | BFF：後端代為保管 token，對瀏覽器只發 session cookie | 瀏覽器端不持有 access token；複雜度放在後端 |
| 手機 App | token：access token + refresh token，refresh token 存在 iOS Keychain 或 Android Keystore 保護的儲存 | App 沒有瀏覽器的同站語意可依賴；系統的安全儲存比 cookie jar 更適合 |
| 第三方或服務對服務的呼叫 | OAuth access token 或 API key | 沒有瀏覽器、沒有使用者在場，見 [OAuth 2.0 與 OIDC](#/skill/oauth-oidc)、[API key 與 MFA](#/skill/api-keys-mfa) |

手機 App 的登入本身，建議透過系統瀏覽器走授權碼 + PKCE（RFC 8252 的建議），而不是在 App 裡做一個自己收密碼的表單；SPA 加手機 App 一起規劃的取捨，可以在設計情境 [SPA 加手機 App 的登入方案](#/scenario/auth-scheme) 裡比較。

## 簽章、框架的 session 與常見錯誤

必讀那段程式的最後一部分：伺服器不查表也能確定內容沒被改過，因為只有持有 `SECRET` 的人算得出正確的簽章。

在真正的框架裡，session 通常由框架或套件處理（例如 Starlette 的 `SessionMiddleware` 是把資料簽章後整包放進 cookie，屬於自帶型；要伺服器端 session 得另外接 Redis 之類的儲存）。選套件時先確認它是哪一種，撤銷行為完全不同。

| 症狀 | 原因 | 怎麼修 |
|---|---|---|
| 登入成功，下一個請求又變成未登入 | 回應的 `Set-Cookie` 被瀏覽器拒收：在 HTTP 上設了 `Secure`、跨站請求沒有 `SameSite=None`、`fetch` 沒帶 `credentials: 'include'`。Chrome DevTools 的 Network 面板會在該 cookie 旁標出被擋下的原因 | 開發環境用 `localhost`（多數瀏覽器把它當安全來源）；跨站時檢查 SameSite 與 CORS credentials 設定 |
| 改密碼後，其他裝置仍然登入著 | 改密碼流程沒有撤銷既有 session 或 refresh token | 改密碼時撤銷該使用者所有 session 與 refresh token，見 [帳號生命週期](#/skill/account-lifecycle) |
| 每個請求都回 `401`，log 顯示 token 過期 | access token 過期後客戶端沒有用 refresh token 換新的，或伺服器與客戶端的時鐘差太多 | 客戶端在收到 401 時換發一次再重試；伺服器驗 `exp` 時容許幾十秒的時鐘誤差 |

## 動手

1. 在上面的 Python 範例裡，把 `issue_token` 的 `ttl` 改成 `900`（15 分鐘），再看「登出所有裝置之後」那一行：失效延遲從 7 天縮到 15 分鐘，短效 access token 的用意在此。
2. 幫 `check_token` 加一個「撤銷清單」：`revoked = set()` 存被撤銷的 token，`logout_all` 時把已知的 token 放進去。想一想：這個清單要放在哪、所有伺服器怎麼共用？做完會發現它就是一個 session 表。
3. 打開瀏覽器 DevTools 的 Application（或 Storage）面板，看一個你常用網站的 cookie，找出它的 session cookie 設了哪些屬性。
4. 到設計情境 [SPA 加手機 App 的登入方案](#/scenario/auth-scheme)，用四個情況比較 cookie session、JWT 放 localStorage、BFF、授權伺服器的取捨。
5. 接著讀 [JWT 解剖](#/skill/jwt)，看自帶型 token 的格式與驗證細節。
