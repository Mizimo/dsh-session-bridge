# 測試

測試分兩層：不需要 DSH 的**單元測試**，以及需要隔離 DSH instance 的 **E2E**。

## 單元測試

```sh
npm test
```

`npm test` 執行 `node --import ./test-support/register.mjs --test`，不需要安裝 DSH 或其他測試依賴（Node 20+）。CI 設定在 Node 20／22／24 上跑。涵蓋：

- `test/index.test.mjs`：透過真正的 `apply()` 與註冊後的工具驗證生命週期／卸載、kill switch、live／stored 列表與並行標題讀取、reference fail-closed、inspect provenance／截斷／redaction、signal 傳遞、送達與 handoff 封裝、UTF-8 訊息 byte 限制、loop guard（含 flush 失敗）、fallback 冷啟動去重與重試、controller 路徑，以及 local／hub 別名與 fail-closed 設定。原生 `session_list` 驗證 `status`，local `list_peers` 驗證 idle live session 仍為 `active: true`。
- `test/refs.test.mjs`：citation 抽取、dotted lookalike fail-closed、完整 id／前綴／ambiguous／missing 匹配、最短前綴與 canonical UUID 驗證。
- `test/hapi-hub.test.mjs`：對 mock hub 驗證 auth（含 401 重認證一次）、list 排序與排除自己、inspect（前綴解析、message 正規化與截斷、ambiguous／not_found）、ping（resume／active／多代 Pi readiness／409 retry／self guard），以及取消、timeout 與 HTTP／連線錯誤分類。訊息 byte 限制由 `index.js` 的工具執行，對應測試在 `test/index.test.mjs`。
- `test/config.test.mjs`：環境旗標、訊息預算、auto／local／hub 模式與 kill switch。
- `test/policy.test.mjs`：scope／allowCwds、訊息封裝與本文轉義、每對 session 的 loop guard 與時間窗。

測試支援檔案放在 `test-support/`，不放在 `test/`，避免 Node 把支援用的 `.js`／`.mjs` 當作測試檔案；也不加入套件發佈的 `files` allowlist。

| 檔案 | 用途 |
| --- | --- |
| `test-support/register.mjs` | 用 `node:module` 的 `register()` 安裝 loader；`--import` 也會套用到 test runner 的子程序。 |
| `test-support/loader.mjs` | 只攔截三個完整的 `@deepseek-ai/dsh-agent`／`dsh-llm`／`dsh-tools` specifier，其他 import 交給 Node 正常解析。 |
| `test-support/stubs/dsh-agent.mjs` | 提供空的 `installModelSelection()`。 |
| `test-support/stubs/dsh-llm.mjs` | `createUserMessage()` 原樣回傳輸入，讓測試檢查 content 與 structured source。 |
| `test-support/stubs/dsh-tools.mjs` | `defineTool()` 原樣回傳定義，測試直接執行註冊的 `execute()`。 |
| `test-support/helpers.mjs` | fake host／agent、scoped registry 與 disposer、session query／controller／flush 等服務、呼叫與 signal 紀錄，以及控制並行順序的 Promise。 |

`index.js` 不需要為測試增加內部 exports。單元測試驗證插件接線與行為；真實 DSH driver、模型與落盤流程仍由 E2E 驗證。測試不連線到真 hub：`test/hapi-hub.test.mjs` 覆寫並恢復 `globalThis.fetch`；index 的 hub 測試也使用 fetch mock。環境變數與 mock 在測試結束後恢復。

## E2E

在**隔離的 DSH instance** 上跑（獨立 `DSH_HOME`、loopback 專用 port、不動主要 DSH service）。詳細的測試床架構、安全規則與踩過的坑見 [`e2e/README.md`](../e2e/README.md) 與 [`e2e/testbed-notes.md`](../e2e/testbed-notes.md)。

`discovery` 刻意讓 A 在 `$TEST_BASE/workspace`、B 在其 `login-page-<token>` 子目錄；安裝後需在隔離 profile 的 `session-bridge` row 設 `scope: host`，再重啟。也可保留 `same-cwd`，以 `allowCwds` 放行測試 workspace 的實際絕對路徑。其他本機 phase 使用相同 cwd，遠端 `hapi` 不受本機 scope 影響；產品預設仍是 `same-cwd`。

### Phase 與驗證內容

共八個 phase，以下結果是既有測試床的驗證紀錄。

| Phase | 驗證內容 | 結果 |
| --- | --- | --- |
| `probe` | plugin 載入、`session_list` 可呼叫、stored 清單欄位存在 | PASS |
| `discovery` | 只用人話（不提工具名／session id／前綴）要求 A 找「正在改登入頁」的 peer、讀進度、送訊息；需呼叫 `session_list`，在送達前先 `session_inspect`，再以 `session_send` 或 `session_handoff` 送達 B，且 B 收到 `[session-bridge]` 訊息 | PASS（A 的實際順序：`session_list`→`session_inspect`→`bash`×2→`session_send`，inspect 目標 = B） |
| `inspect` | 送訊息給 B 後，用 B 的 uuid 前綴 `session_inspect`：讀到目標、`live:true`、relay 訊息 `fromAgent:true`、assistant 文字 | PASS |
| `dialogue` | A→B `PING`、B→A `PONG` 雙向送達；log 內 `source.kind='agent-message'`、`senderSessionId` 正確 | PASS |
| `handoff` | summary／task／回報指示完整送達；B 用 `session_send` 回報 `HANDOFF-OK`，A 收到 | PASS |
| `cold-prepare` | 從既有 state 讀取 A，將其 id 儲存為 `coldTarget`，提示操作者重啟 instance | PASS |
| `cold` | 重啟 instance（全冷）→ C 先 `session_inspect` 冷 A（`live:false`，且 A 仍冷）→ C 送訊息 → `coldResumed:true` 喚醒 → A 回 `COLD-PONG` → C 收到 | PASS |
| `hapi` | `list_peers`／`inspect_peer`／`ping_peer` 對拋棄式 HAPI session；hub API 直接驗證訊息送達、`[session-bridge]` 前綴、sender id 正確 | PASS |

### 怎麼跑

```sh
# 1. 起隔離 instance（DSH_BIN 未設定時從 PATH 找 dsh）
export TEST_BASE=$HOME/session-bridge-test
./e2e/start-test-instance.sh

# 2. 裝 plugin；在隔離 profile 的 session-bridge row 設 config: {scope: host}
./e2e/install-plugin-bundle.sh /abs/path/to/dsh-session-bridge
# 合併設定後重啟，讓 bundle 與 discovery 的 scope 設定生效
./e2e/stop-test-instance.sh && ./e2e/start-test-instance.sh

# 3. 依序跑 phase
export DSH_WEB_URL=http://127.0.0.1:3099
node e2e/bridge-e2e.mjs probe
node e2e/bridge-e2e.mjs discovery
node e2e/bridge-e2e.mjs inspect
node e2e/bridge-e2e.mjs dialogue
node e2e/bridge-e2e.mjs handoff
node e2e/bridge-e2e.mjs cold-prepare
./e2e/stop-test-instance.sh && ./e2e/start-test-instance.sh
node e2e/bridge-e2e.mjs cold

# 4. 收尾
./e2e/stop-test-instance.sh
rm -rf "$TEST_BASE"
```

`hapi` phase 需要可達的 HAPI hub、hub token 環境變數、以及自己建的拋棄式 HAPI `dsh` session（`HAPI_TEST_SESSION_ID`）；細節見 [`e2e/README.md`](../e2e/README.md)。需要瀏覽器 token 的 stock DSH 安裝用 `DSH_WEB_COOKIE` 傳 session cookie。

E2E 會真的呼叫模型，每個 roundtrip 約 0.3–0.7k tokens；prompt 保持短。

## 驗證矩陣

| 項目 | 環境 | 結果 |
| --- | --- | --- |
| 全套 E2E（八個 phase + 冷啟動重啟） | 隔離 DSH 0.2.0-rc.2 + 本機 loopback HAPI hub 0.30.7 | 全部 PASS |
| 自然語言 discovery（無工具名／id 提示） | 隔離 DSH 0.2.0-rc.2 測試床（與上列同一套安裝） | PASS（`session_list`→`session_inspect`→`session_send`，B 收到 `[session-bridge]` relay） |
| 從 GitHub `github:…#v0.2.0` 安裝 + `probe` | 全新 `DSH_HOME`、stock DSH 0.2.1-rc.2 CLI | PASS（`session_list` 工具可用） |
| 從 GitHub `github:…#v0.2.0` 安裝 | 全新 `DSH_HOME`、stock DSH 0.2.0-rc.2 CLI | PASS（bundle row 進 composition、依賴與安裝檔正確） |
| v0.2.1 套件結構 | `npm pack --dry-run` 檔案清單與 v0.2.0 相同（只改 prompt 與版本） | PASS |
| 單元測試 | Node 20／22／24（GitHub Actions） | PASS |
| HAPI wire | 與 HAPI 0.31.2 原始碼比對；0.30.7 實測 | 用到的 route 相同 |

## 已知測試床陷阱

- `turnOutline` 只留每個 turn 的最後一條 response；同一 turn 內的中間步驟要用 session page 的 assistant 文字輪詢（`waitForAssistantText`）。
- `throughSeq: -1` 會回空頁；用 `session/projections` 的 `asOfSeq`。
- 送達／工具結果要等對應 event commit 後再斷言，不能看到第一個證據就斷言。
- 一個 profile 同時間只能有一個 writer；裝完 bundle 一定要重啟。

完整清單見 [`e2e/testbed-notes.md`](../e2e/testbed-notes.md)。
