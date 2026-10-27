# 運作原理

外掛是單純的 **Host-only Cordis bundle**：一段 patch row + 幾個纯 ESM 的 JS 檔，沒有 client 半、沒有 build step。它在每個 top-level session 的 agent 上註冊工具與一段 system prompt。

## 檔案結構

| 檔案 | 職責 |
| --- | --- |
| `index.js` | plugin 入口：`apply()`、session 列舉／讀取／送達、四個原生工具、HAPI 別名工具、system prompt policy。 |
| `hapi-hub.js` | HAPI hub REST client（`createHapiHubClient` / `HapiHubError`），處理 auth、list、inspect、resume、send 與錯誤分型。 |
| `refs.js` | session reference 解析：citation 抽取、id／前綴匹配、ambiguous 判斷。 |
| `cordis.patch.yml` | bundle 的 patch 層：插入 `session-bridge` row（optional）。 |
| `locale/`、`icon.svg` | 插件管理介面用的顯示資源。 |
| `test/`、`e2e/` | 單元測試與隔離測試床（不隨套件發佈）。 |

## 生命週期

- `inject = ['agents', 'tools', 'systemPrompt']`；其他能力（`sessionController`、`sessionQuery`、`agentPresets`…）用 `ctx.get()` 選配。
- `apply()` 解析 config／kill switch 後，對每個已存在的 top-level agent 與之後 `agent/created` 的 agent 呼叫 `install()`。
- `install()` 在 agent 自己的 context 註冊工具與 prompt section；disposer 掛在 `ctx.effect`，`agent/disposed` 時卸載，避免外掛跟著舊 agent 累積。
- 只有 top-level session 會拿到工具；subagent／teammate child 不註冊，避免遞迴與權限混亂。

## 枚舉

- live session：`ctx.agents.roots()`，排除自己與 subagent child；狀態用 `agent.status`，標題用 `sessionTitle.get()`，`updatedAt` 由 `snapshotEvents(seq-1, seq)` 取得。
- stored session：`ctx.get('sessionController').list()` + `sessionQuery.readTitle()`，最多列 30 筆，依最近活動排序。
- 兩者合併成 `session_list` 的 `sessions`／`stored`。

## 送達

```js
const message = createUserMessage({
  content: [textBlock(header), textBlock(body)],
  source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id },
})
target.steer(message)
await ctx.get('sessions')?.flush?.(target.session)
```

- 跟 DSH 內建 Agent Teams 同一條 durable 通道；`steer` 在 idle 時會啟動新 turn，running 時在下一個 step 邊界插入。
- `flush` 只保證「已提交的 session events」落盤，用來讓 sender 在回報成功前盡量收斂；剛進 inbox 的訊息要等 target driver 取用才進 log。
- 目標不在記憶體時先 resume（見下），成功後回 `coldResumed: true`。

## 讀取

- `sessionQuery.readSession(id)` 對 log 做完整 replay，**不會**把 session 變成 live。
- 逐 event 抽 `user/message` → `data.content`、`assistant/message` → `data.message.content`、`session/title` → `data.title`；tool call 只留名稱。
- `user/message` 的來源在 `data.source`；`kind = 'agent-message'` 的訊息標 `fromAgent: true` 並保留 `senderSessionId` 供工具回傳。
- 單則 600 字、總量 16 KiB、預設 8 則（上限 30）；截斷時 `truncated: true`。

## 冷啟動

目標 session 存在但不在記憶體時，優先走 web bundle 的 `ctx.get('sessionController').resolveAgent(sessionId)`——這是 GUI 開 session 的同一條路徑，preset、模型選擇、去重都交給 host。

沒有 session-controller 的 deployment 才用可攜 fallback：

1. `sessionQuery.observeSession(id)` 讀 header；
2. `agentPresets.resolve(...)` 找 preset；
3. `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`，`setup` 內用 `installModelSelection`（0.2.0 是 `(agentCtx, selection)`、較新版本是單參數；fallback 用 `{ current: selection }` 呼叫，兩版都相容）＋ `preset.mount`。

## Reference 解析

- `normalizeSessionRef()`：先 trim；若字串含 `/sessions/`，抽出其中 id；抽出多個不同 id 時回空字串（fail closed），只有一個才使用。
- `matchSessionRef()`：完整 id 優先，其次唯一前綴；多個匹配回 `ambiguous`，沒有匹配回 `missing`。
- DSH id 是 `session-<uuid>`，所以額外接受「只給 uuid 前綴」的形式（補上 `session-` 再比對），GUI／API 常見的裸 uuid 也能用。

## HAPI hub client

- 建 client 時解析 `apiUrl`／`accessToken`／`extraHeaders`／`selfSessionId`，缺 token 直接丟 `bad_args`，由 plugin 退回 local 別名。
- `POST /api/auth` 換 JWT，single-flight 快取；任何請求遇到 401 會重認證一次再重試。
- 每次呼叫有 timeout（一般 20s、auth 10s、resume／send 30s）；`TimeoutError` 對應 `timeout`、呼叫端取消對應 `disabled`。
- `inspect_peer` 先用 list 解析前綴，再 `GET /:id` 取最新 metadata，最後讀 messages——不 resume。
- `ping_peer` 解析目標後先確保 active：必要時 `POST /resume` → 輪詢 active（2s／最多 60s）；pi flavor 另外等 `metadata.piSessionId`。送訊息用穩定 `localId`；409 `session_inactive` 會重新確認後重送一次。
- 所有 hub 錯誤轉成有型別的 `HapiHubError`，讓模型看到 `not_found`／`ambiguous`／`timeout` 等可操作訊息。

## 設計取捨與失敗窗口

- **沒有廣播、沒有 hop 上限**：一次一個目標；單則大小有上限，但 ping-pong 次數沒有。請在 prompt 裡要求「回報一次即可」。
- **flush 不是完整 durability**：steer 被接受後、target driver 取用前，process crash 仍有小窗口會丟訊息；要完全避免需要在 host 端改 delivery 語意。
- **HAPI 單向**：DSH 不是 hub 上的 session，除非跑在 `hapi dsh` 底下，否則回覆只能用 `inspect_peer` 讀。
- **prefer host 路徑**：冷啟動優先用 `sessionController.resolveAgent`，只有在 host 沒提供時才走可攜 fallback；兩條路徑都不會直接改 session 檔案。
- **fail closed**：多個 citation id、ambiguous 前綴、超過 byte budget 都直接報錯，不猜。
- **共用 host 服務**：所有讀寫都經 `sessionQuery`／`sessionController`／`agents`，不直接碰 `~/.dsh/sessions` 檔案。

## 使用到的 Host API

`agents.roots/resume/get`、`agent.status`、`sessionController.list/resolveAgent`、`sessionQuery.readSession/listSessions/readTitle/observeSession`、`agentPresets.resolve/mount`、`agentDefaultModel.currentSelection`、`sessionTitle.get`、`sessions.flush`、`createUserMessage`、`defineTool`、`agent/created`／`agent/disposed`。

目標 runtime 是 DSH 0.2.x（`peerDependencies: >=0.2.0-rc.1 <0.3.0`）；用到的 API 在 0.2.0-rc.2 與 0.2.1-rc.2 都驗證過。
