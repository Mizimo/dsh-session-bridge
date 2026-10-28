# 設定

外掛是單純的 Host-only bundle，全部設定都在 profile 的 Cordis patch row 或環境變數，沒有 client 設定。

## Row config

裝好之後，profile 的 `cordis.patch.yml`（或任何較高優先的 patch 層）可以覆寫這個 row：

所有欄位都是選用的；不設定時的行為和 v0.2.1 相同。下面是一個開啟選用限制的例子：

```yaml
- id: session-bridge
  config:
    enabled: true
    maxMessageBytes: 65536
    scope: same-cwd        # 預設 host
    allowCwds: []
    loopGuard: true        # 預設 false；也可給 {windowMs, maxMessages}
    hapiCompat: auto
    hapiHub:
      apiUrl: http://127.0.0.1:3006
      # accessToken: 建議改用 CLI_API_TOKEN 環境變數
```

| 欄位 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` 時完全不註冊工具（含 system prompt 段）。 |
| `maxMessageBytes` | integer | `65536` | `session_send`／`session_handoff`／local 與 hub `ping_peer` 的單則訊息 byte 上限，換行與中文都算 UTF-8 bytes。 |
| `scope` | `host` \| `same-root` \| `same-cwd` | `host` | 本機對話讀取與送達範圍。`host`（預設，同 v0.2.1）允許同 host 的所有 ordinary session；`same-cwd` 要求相同工作目錄；`same-root` 另允許互為祖先／子目錄。無法辨識的值會印 warning 並使用 `same-cwd`，打錯字不會放寬範圍。 |
| `allowCwds` | string[] | `[]` | 搭配 `same-cwd`／`same-root`：額外允許的目標工作目錄及其子目錄。展開開頭的 `~/`，再以 `path.resolve()` 轉為絕對路徑；相對路徑以 host process 的 cwd 為準，無效項目忽略。 |
| `loopGuard` | `false` \| `true` \| object | `false` | 每組有方向性的 sender → target，在滑動時間窗內最多送出的訊息數。預設關閉（同 v0.2.1）；`true` 等於 `{ windowMs: 60000, maxMessages: 10 }`。 |
| `hapiCompat` | `auto` \| `local` \| `hub` \| `false` \| `none` | `auto` | HAPI 同名工具要接到哪裡；見 [HAPI 相容](hapi.md)。 |
| `hapiHub` | object | — | hub client 設定；存在這個區塊時，`auto` 會選擇 hub。欄位見下。 |

`auto` 在存在 `hapiHub` 區塊，或 `CLI_API_TOKEN` 非空白時選擇 hub（同 v0.2.1；`HAPI_API_URL` 可省略，預設 `http://127.0.0.1:3006`），否則使用 local。hub client 建立失敗時，`auto` 會印 warning 並退回 local 別名；明確設定 `hapiCompat: hub` 則印 warning 並停用三個 HAPI 同名工具，保留原生 `session_*` 工具。

選用 `same-cwd`／`same-root` 時，本機範圍以正規化後的目錄路徑比較；`same-root` 不代表尋找 Git root，同層的兄弟目錄不會因此互通。`allowCwds` 只放行指定目標目錄及其子目錄，`/work/proj2` 不屬於 `/work/proj`。這兩種模式下雙方都必須有可驗證的 cwd；缺少 cwd 時，即使有 allowlist 也不會盲目 resume（沒有 session controller 的 deployment 事先拿不到冷 session 的 cwd，所以在這兩種模式下無法喚醒冷 session）。超出範圍的 `session_inspect`／local `inspect_peer` 保留 metadata，回 `messages: []`、`truncated: false` 與 `redacted: true`；`session_send`／`session_handoff`／local `ping_peer` 則直接拒絕且不 resume。遠端 HAPI hub 目標不套用本機 cwd 範圍。

開啟 `loopGuard` 時，`windowMs` 與 `maxMessages` 各自接受正的 safe integer，無效值分別使用 60000 毫秒與 10 則。原生工具及本機別名共用配對計數；hub `ping_peer` 以解析後的 session id 計數，同一目標的不同前綴寫法共用額度；反向回覆是另一組配對。計數僅存在這次 plugin 啟用的記憶體中，重新啟動後歸零。

`hapiHub` 欄位（全部可選，憑證可改用環境變數）：

| 欄位 | 說明 |
| --- | --- |
| `apiUrl` | HAPI hub base URL。優先序：row config > `HAPI_API_URL` > `http://127.0.0.1:3006`。 |
| `accessToken` | HAPI 的 CLI access token。優先序：row config > `CLI_API_TOKEN`。 |
| `extraHeaders` | 額外 HTTP header（HAPI 的 namespace／反代場景）；`HAPI_EXTRA_HEADERS_JSON` 可給 JSON 字串。 |
| `selfSessionId` | 這個 DSH process 在 HAPI 上的 session id；預設讀 `HAPI_SESSION_ID`。拿來排除自己、並在 `ping_peer` 訊息附回覆位址。 |
| `timeoutMs` | 一般 hub 請求 timeout，預設 20000；resume／送訊息另有 30 秒上限。 |
| `waitActiveSecs` | resume 後等 session 變 active 的上限，預設 60 秒。 |

## 環境變數

| 變數 | 作用 |
| --- | --- |
| `DSH_SESSION_BRIDGE_DISABLE` | 全域 kill switch，優先於 row config；僅字串值去除前後空白並轉小寫後為 `1`／`true`／`yes` 時啟用，其他值不啟用。 |
| `HAPI_API_URL` | hub URL（hub 模式時使用；未設定時為 `http://127.0.0.1:3006`）。 |
| `CLI_API_TOKEN` | HAPI CLI access token；非空白時 `auto` 會選擇 hub。**建議用這個而不是把 token 寫進 YAML**。 |
| `HAPI_EXTRA_HEADERS_JSON` | JSON 物件，附加到每個 hub 請求。 |
| `HAPI_SESSION_ID` | 由 `hapi dsh` 啟動時 HAPI 會 export；plugin 用它排除自己並提供回覆位址。 |
| `HAPI_DISABLE_PEER_TOOLS` | HAPI 原生 kill switch；`1`／`true`／`yes` 時不註冊同名相容工具，忽略前後空白與大小寫（跟 HAPI 行為一致）。 |

## 憑證安全

- token 寫進 profile config 就是**明文**，會進 profile 的 `package.json`／`cordis.patch.yml` 或 patch 檔；優先用 `CLI_API_TOKEN` 環境變數（systemd `EnvironmentFile`、shell profile 等），並確保檔案權限 600。
- 不要把 token commit、貼進 issue/log、或寫進 session 可讀的檔案。
- plugin 不會把 token 放進工具回傳、錯誤訊息或 system prompt；hub client 失敗只印 warning。

## 生效與驗證

- 改 config／環境變數後要**重啟 profile 的 dsh process**；bundle 的 JS 與 patch row 都不熱重載。
- `web` profile 的 row 是 optional：載入失敗只會印 `dsh: warning: 1 entry did not activate`，不會擋開機。所以驗證方式是「新 session 裡有沒有 `session_list`」，不是只看 process 起來。
- 用 `dsh --profile <name> --dump-config` 可以在啟動前確認 composition 裡有 `- id: session-bridge`。

## 關閉與移除

- 暫時關閉：row config `enabled: false`，或 `DSH_SESSION_BRIDGE_DISABLE=1`（環境變數優先）。
- 只關 HAPI 別名：`hapiCompat: false`（原生 `session_*` 工具不受影響）。
- 移除 bundle：

```sh
dsh plugin --profile <profile> remove dsh-session-bridge
```

移除後同樣要重啟。
