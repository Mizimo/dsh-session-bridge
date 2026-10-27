# 測試

測試分兩層：不需要 DSH 的**單元測試**，以及需要隔離 DSH instance 的 **E2E**。

## 單元測試

```sh
npm test
```

`node --test`，零依賴（Node 20+），CI 在 Node 20／22／24 上跑。涵蓋：

- `test/refs.test.mjs`：citation 抽取、dotted lookalike fail-closed、完整 id／前綴／ambiguous／missing 匹配。
- `test/hapi-hub.test.mjs`：對 mock hub 驗證 auth（含 401 重認證一次）、list 排序與排除自己、inspect（前綴解析、message 正規化、ambiguous／not_found）、ping（resume／active／409 retry／self guard／byte 限制）。

HAPI hub client 用注入的 `fetch` 打 mock，不需要真 hub。plugin 本体（`index.js`）依賴 DSH host 服務，由 E2E 覆蓋。

## E2E

在**隔離的 DSH instance** 上跑（獨立 `DSH_HOME`、loopback 專用 port、不動主要 DSH service）。詳細的測試床架構、安全規則與踩過的坑見 [`e2e/README.md`](../e2e/README.md) 與 [`e2e/testbed-notes.md`](../e2e/testbed-notes.md)。

### Phase 與驗證內容

| Phase | 驗證內容 | 結果 |
| --- | --- | --- |
| `probe` | plugin 載入、`session_list` 可呼叫、stored 清單欄位存在 | PASS |
| `inspect` | 送訊息給 B 後，用 B 的 uuid 前綴 `session_inspect`：讀到目標、`live:true`、relay 訊息 `fromAgent:true`、assistant 文字 | PASS |
| `dialogue` | A→B `PING`、B→A `PONG` 雙向送達；log 內 `source.kind='agent-message'`、`senderSessionId` 正確 | PASS |
| `handoff` | summary／task／回報指示完整送達；B 用 `session_send` 回報 `HANDOFF-OK`，A 收到 | PASS |
| `cold` | 重啟 instance（全冷）→ C 先 `session_inspect` 冷 A（`live:false`，且 A 仍冷）→ C 送訊息 → `coldResumed:true` 喚醒 → A 回 `COLD-PONG` → C 收到 | PASS |
| `hapi` | `list_peers`／`inspect_peer`／`ping_peer` 對拋棄式 HAPI session；hub API 直接驗證訊息送達、`[session-bridge]` 前綴、sender id 正確 | PASS |

### 怎麼跑

```sh
# 1. 起隔離 instance
./e2e/start-test-instance.sh

# 2. 裝 plugin、重啟讓 bundle 生效
./e2e/install-plugin-bundle.sh /abs/path/to/dsh-session-bridge
./e2e/stop-test-instance.sh && ./e2e/start-test-instance.sh

# 3. 依序跑 phase
export DSH_WEB_URL=http://127.0.0.1:3099 TEST_BASE=$HOME/session-bridge-test
node e2e/bridge-e2e.mjs probe
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
| 全套 E2E（六 phase + 冷啟動重啟） | 隔離 DSH 0.2.0-rc.2 + 本機 loopback HAPI hub 0.30.7 | 全部 PASS |
| 從 GitHub `github:…#v0.2.0` 安裝 + `probe` | 全新 `DSH_HOME`、stock DSH 0.2.1-rc.2 CLI | PASS（`session_list` 工具可用） |
| 從 GitHub `github:…#v0.2.0` 安裝 | 全新 `DSH_HOME`、stock DSH 0.2.0-rc.2 CLI | PASS（bundle row 進 composition、依賴與安裝檔正確） |
| 單元測試 | Node 20／22／24（GitHub Actions） | PASS |
| HAPI wire | 與 HAPI 0.31.2 原始碼比對；0.30.7 實測 | 用到的 route 相同 |

## 已知測試床陷阱

- `turnOutline` 只留每個 turn 的最後一條 response；同一 turn 內的中間步驟要用 session page 的 assistant 文字輪詢（`waitForAssistantText`）。
- `throughSeq: -1` 會回空頁；用 `session/projections` 的 `asOfSeq`。
- 送達／工具結果要等對應 event commit 後再斷言，不能看到第一個證據就斷言。
- 一個 profile 同時間只能有一個 writer；裝完 bundle 一定要重啟。

完整清單見 [`e2e/testbed-notes.md`](../e2e/testbed-notes.md)。
