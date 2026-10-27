# dsh-session-bridge

讓同一個 DSH host 裡**不同 session 的 agent 互相傳訊息、讀對方 log、交接工作**的 DSH bundle（Host-only plugin，無 client 半、無 build step）。另外提供一層**可選的 HAPI 相容介面**：同樣的 `list_peers`／`inspect_peer`／`ping_peer` 工具名稱，可以接本機 DSH session，也可以接真正的 HAPI hub。

## 功能

裝進一個 profile 後，每個 top-level session 的 agent 會多四個工具：

| 工具 | 用途 |
| --- | --- |
| `session_list` | 列出這個 host 上的其他 session：活著的 session（id、title、cwd、running/idle、updatedAt），以及目前沒在跑、但 `session_send` 可以喚醒的 stored session |
| `session_inspect` | **唯讀**讀取一個 session 的 title、cwd、狀態與最近幾則 user/assistant 訊息文字；不會喚醒對方，也不會消耗對方 token。回覆如果是另一個 agent 傳的，會標 `fromAgent: true` |
| `session_send` | 送一則訊息到指定 session；對方 idle 會開新 turn，正在跑則在下一個 step 邊界吃到 |
| `session_handoff` | 把工作交接出去：打包「目前狀態 summary + 接下來要做的 task」，要求對方完成後回報 |

`target`／`sessionIdPrefix` 都接受三種寫法：

1. 完整 session id；
2. **唯一前綴**（例如前 8 碼，跟 HAPI 一致；DSH session id 是 `session-<uuid>`，只給 uuid 前綴也可以；撞號會回 `ambiguous` 並列出樣本）；
3. 任何含 `/sessions/<id>` 的字串（HAPI web 的 copy-reference、markdown composer chip、貼上的引用段落）。

## 來源標記

收到的 peer 訊息不是人類使用者打的，這點在三個地方看得到：

- session log 的結構化來源：`source.kind = 'agent-message'`、`source.form = 'relay'`、`source.senderSessionId = <真正的 sender session id>`；
- 訊息本文開頭：`[session-bridge] Message|Handoff from DSH session "<id>" (title)` + sender workspace；
- system prompt 的 policy 段要求模型把 peer 訊息當 untrusted，不能藉此擴大權限。

送到 HAPI hub 的訊息（`ping_peer`）也一樣：本文開頭固定是 `[session-bridge] Agent message from DSH session "<id>"`，並明說「這是 agent 對 agent 的自動訊息，不是人類使用者」。HAPI hub 只收純文字，沒有 metadata 通道，所以對 HAPI 這一側用文字標記補上。

## HAPI 相容層

HAPI（[tiann/hapi](https://github.com/tiann/hapi)）的 peer tools 叫 `list_peers`／`inspect_peer`／`ping_peer`。本 plugin 提供同名工具，`hapiCompat` 決定它們接到哪裡：

| 模式 | 別名工具接什麼 | 何時用 |
| --- | --- | --- |
| `hub` | 真正的 HAPI hub REST API（`/api/sessions`、`/api/sessions/:id/messages`、`/resume`、`/messages`） | DSH 要跟 HAPI 上的 session 對話；HAPI hub 可在同機 loopback 或 tailnet |
| `local` | 本機 DSH session（跟 `session_*` 同一批目標） | 現成的 HAPI 寫法／skill／prompt 想直接跑在純 DSH 上，沒有 hub |
| `auto`（預設） | 有 `hapiHub` 設定或 `HAPI_API_URL`+`CLI_API_TOKEN` 就 `hub`，否則 `local` | 一般情況 |
| `false` | 不註冊別名工具（只留 `session_*`） | 不想讓模型看到兩套名字 |

`hub` 模式的行為對齊 HAPI：唯一前綴解析、`active` 判斷、對 inactive session 先 `POST /resume` 再等 active（2 秒輪詢、最多 60 秒；pi session 另外等 `piSessionId`）、錯誤分型（`bad_args`／`auth_failed`／`not_found`／`ambiguous`／`resume_failed`／`timeout`／`send_failed`）。`inspect_peer` 是唯讀的，不會 resume。

設定範例：

```yaml
- id: session-bridge
  config:
    hapiCompat: hub
    hapiHub:
      apiUrl: http://127.0.0.1:3006   # 也可以是 tailnet 上的 hub URL
      # accessToken: ...              # 建議改用環境變數，見下
      # extraHeaders: {...}           # HAPI 的 namespace 機制：自訂 header
      # selfSessionId: ...            # 若 DSH 本身跑在 hapi dsh 底下，預設讀 HAPI_SESSION_ID
      # timeoutMs: 20000
      # waitActiveSecs: 60
```

憑證也可以用環境變數給（優先序：row config > 環境變數 > 預設）：

- `HAPI_API_URL`：hub URL，預設 `http://127.0.0.1:3006`；
- `CLI_API_TOKEN`：HAPI 的 CLI access token（`~/.hapi/settings.json` 的 `cliApiToken`）；
- `HAPI_EXTRA_HEADERS_JSON`：JSON 物件，對齊 HAPI 的 extra headers（namespace 用）；
- `HAPI_SESSION_ID`：若這個 DSH process 是被 `hapi dsh` 拉起來的，HAPI 會 export 它；plugin 會拿來排除自己、並在 `ping_peer` 訊息裡附上「回覆位址」。

**注意**：token 放進 profile config 就是明文，優先用環境變數；不要把 token commit 或貼進 log。hub mode 建 client 失敗（缺 token／URL）時會印 warning 並自動退回 `local` 別名，不會擋開機。

### HAPI 相容的限制

- **單向送達**：DSH session 本身不是 HAPI hub 上的 session，所以 HAPI 那一側不能用 `ping_peer` 回呼；回覆要用 `inspect_peer` 去讀對方 conversation 的尾端。
- 唯一例外：DSH 跑在 `hapi dsh` 底下時（有 `HAPI_SESSION_ID`），送出的訊息會附上回覆位址，對方可以用 `ping_peer` 回呼，等於雙向。
- hub 只收純文字，附件／metadata 不支援；來源靠本文的 `[session-bridge]` header 表達。
- 一次只有一個目標；沒有廣播。

## 運作方式

- 枚舉：`ctx.agents.roots()`（只含 top-level session，排除 subagent／teammate child），標題用 `sessionTitle.get()`；stored session 用 `ctx.get('sessionController').list({}, signal)` + `sessionQuery.readTitle()`（最多列 30 筆，依最近活動排序）。`updatedAt` 由 `snapshotEvents(seq-1, seq)` 取得。
- 送達：`createUserMessage({ content, source: { kind: 'agent-message', form: 'relay', senderSessionId } })` + `target.steer(message)`，再 `ctx.get('sessions').flush()`。跟 DSH 內建 Agent Teams 同一條 durable 通道；steer 在 idle 時會啟動 turn。
- 讀取：`sessionQuery.readSession(id)` 做完整 replay（不會把 session 變成 live），逐 event 取出 user/assistant 文字、tool call 名稱、`user/message` 的 `data.source`；單則截到 600 字、總量 16 KiB、預設 8 則（上限 30）。
- 冷啟動：目標 session 存在但不在記憶體時，優先走 web bundle 的 `ctx.get('sessionController').resolveAgent(sessionId)`（GUI 開 session 的同一條 resume 路徑：preset、模型選擇、去重都交給它）；若 host 沒有 session-controller，才用可攜的 fallback：`sessionQuery.observeSession()` → 讀 `agentPreset` → `ctx.agents.resume({ resumeSessionId, agentOptions, setup: installModelSelection + preset.mount })`。
- 每個 agent 的註冊都掛在 `ctx.effect`／`agent/disposed`，agent 結束就卸載。整個 plugin 可用 row config `enabled: false` 或環境變數 `DSH_SESSION_BRIDGE_DISABLE=1` 關掉（環境變數優先）。

## 設定

row config（全部可選）：

```yaml
- id: session-bridge
  config:
    enabled: true              # false = 完全不註冊工具
    maxMessageBytes: 65536     # 單則訊息上限，預設 64 KiB
    hapiCompat: auto           # auto|local|hub|false
    hapiHub:                   # 只有 hub 模式需要
      apiUrl: http://127.0.0.1:3006
      accessToken: <或用 CLI_API_TOKEN>
```

## 安裝（profile）

從 GitHub 安裝（建議釘版本 tag）：

```bash
dsh plugin --profile <profile> add github:Mizimo/dsh-session-bridge#v0.2.0
```

或從本機 checkout 裝（開發用，改完 code 要重裝＋重啟）：

```bash
dsh plugin --profile <profile> add /abs/path/to/dsh-session-bridge
```

bundle 會自動加進該 profile 的 `dsh.profile.bundles`；**重啟該 profile 的 dsh process 後生效**（bundle 的 patch/JS 不熱重載）。

> DSH Desktop 的 `desktop` profile 由 GUI 管理，CLI 會拒絕該 profile 的 plugin 操作；Desktop 請用內建插件管理介面（或 GUI 終端）安裝，其餘 `web`／`headless`／自訂 profile 用上面的 CLI。

web profile 的 plugin row 是 optional：外掛載入失敗**不會擋開機**，只會印 `dsh: warning: 1 entry did not activate`。所以驗證成敗要看「新 session 裡有沒有 `session_list` 工具」，不是只看 process 起得來。

移除：

```bash
dsh plugin --profile <profile> remove dsh-session-bridge
```

## 使用流程（模型側）

1. `session_list` 找目標 session id（活著的，或 stored 清單裡可喚醒的）。
2. 想先看對方做到哪，用 `session_inspect`（唯讀、不喚醒）。
3. `session_send` 問問題／請對方做事；`session_handoff` 把擁有權交出去（summary + task，預設要求回報）。
4. 對方完成後用 `session_send` 回報 sender 的 session id；原本的 session 被喚醒後繼續工作。
5. 接 HAPI 時：`list_peers` → `inspect_peer`（先看對方最近訊息）→ `ping_peer` 送訊息 → 再 `inspect_peer` 讀回覆。

## 限制與風險

- 本機層面同一個 `dsh` host process 內的 session 才互通；跨機器、跨 process 不支援（HAPI 相容層是唯一的跨機器路徑，且要有一個 hub）。
- 一次只有一個目標；沒有「廣播」。
- 送達會喚醒對方、消耗 token；互相回話可能無限 ping-pong。plugin 只在單則訊息大小設上限，**沒有 hop 次數上限**，請在指示裡收斂（例如「回報一次即可」）。
- `session_inspect` 只回最近訊息與 tool 名稱，不是完整 transcript；被截斷時會標 `truncated: true`。
- 對冷 session 送訊息會把它 resume 成 live agent；失敗（例如 preset 需要 headless 拒用的東西）會回報錯誤，不會弄壞 session；跟 GUI 同時開同一個 session 由 session-controller 去重。
- peer 訊息是另一個 agent 傳的，不是人類使用者；system prompt 已要求把它當 untrusted，不能藉此擴大權限。
- `flush` 只保證「已提交的 session events」落盤；剛 steer 進 inbox 的訊息要等對方 driver 取用才進 log，process 在那一瞬間 crash 仍有小窗口會丟訊息。
- HAPI hub 模式會喚醒 HAPI session（跟 HAPI 原生 `ping_peer` 一樣）；對使用者的既有 session 送訊息前請自己確認。沒在跑的 session 被 resume 需要對應 machine 的 runner 在線。
- 未在多 session 併發壓測；目標是單人開發環境的交接。

## 測試

在隔離測試機上跑 E2E（DSH 0.2.0-rc.2、`deepseek-flash`、獨立 `DSH_HOME`、loopback 專用 port；該機的主要 DSH service 全程未動）。v0.2 另接該機既有的 HAPI hub（`@twsxtd/hapi` 0.30.7，loopback），只對自己建的 throwaway HAPI `dsh` session 送訊息：

| Phase | 驗證內容 | 結果 |
| --- | --- | --- |
| `probe` | plugin 載入、`session_list` 可呼叫、stored 清單欄位存在 | PASS |
| `inspect` | A 送 B 訊息後，用 B 的 8 碼前綴 `session_inspect`：讀到目標、`live:true`、relay 訊息 `fromAgent:true`、assistant 文字 | PASS |
| `dialogue` | A→B `PING`、B→A `PONG` 雙向送達；log 內 `source.kind='agent-message'`、`senderSessionId` 正確 | PASS |
| `handoff` | summary/task/回報指示完整送達；B 用 `session_send` 回報 `HANDOFF-OK`，A 收到 | PASS |
| `cold` | 重啟 instance（全冷）→ C 先 `session_inspect` 冷 A（`live:false`，且 A 仍冷）→ C 送訊息 → `coldResumed:true` 喚醒 → A 回 `COLD-PONG` → C 收到 | PASS |
| `hapi` | `list_peers`／`inspect_peer`／`ping_peer` 對 throwaway HAPI session；hub API 直接驗證訊息送達、`[session-bridge]` 來源前綴、sender id 正確 | PASS |

重跑工具在 `e2e/`：`start-test-instance.sh`／`stop-test-instance.sh`／`install-plugin-bundle.sh`／`bridge-e2e.mjs`（phases：`probe`／`inspect`／`dialogue`／`handoff`／`cold-prepare`→重啟→`cold`／`hapi`），用法見 `e2e/README.md`。`hapi` phase 需要 `HAPI_TEST_SESSION_ID`（我們的 throwaway session）與 token 環境變數，細節見 `e2e/testbed-notes.md`。

## 相容性

- 實機驗證：DSH **0.2.0-rc.2**（CLI，npx 安裝）與 **0.2.1-rc.2**（DSH Desktop）；HAPI **0.30.7** hub（wire：`/api/auth`、`/api/sessions`、`/api/sessions/:id`、`/messages`、`/resume`，與 0.31.2 原始碼比對一致）。
- 目標：DSH 0.2.x（`peerDependencies: >=0.2.0-rc.1 <0.3.0`）。
- 用到的 API：`agents.roots/resume/get`、`agent.status`、`sessionController.list/resolveAgent`、`sessionQuery.readSession/listSessions/readTitle`、`agentPresets.resolve/mount`、`agentDefaultModel.currentSelection`、`sessionTitle.get`、`sessions.flush`、`createUserMessage`、`defineTool`、`agent/created/disposed`。
- `installModelSelection` 在 0.2.0 是 `(agentCtx, selection)`、較新版本是單參數；fallback 路徑用 `{ current: selection }` 呼叫，兩版都相容。
