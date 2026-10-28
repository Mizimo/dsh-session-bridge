# 工具參考

外掛會為每個一般 top-level session 的 agent 註冊工具。沒有 HAPI 相容層時是四個 `session_*` 工具；相容層成功啟用時再多三個 HAPI 同名的別名。明確設定 hub 但 client 無法建立時，只保留原生工具（見 [HAPI 相容](hapi.md)）。

## Agent 怎麼知道要用

安裝後 agent 不是靠 README 或使用者的指令才知道的：

- **工具定義本身**：DSH 會把工具名稱、description、參數 schema 放進 session 的模型 context；模型看到 `session_list` 等工具與用途就能直接呼叫。
- **system prompt 的 policy 段**：`install()` 會在每個 top-level session 掛一段 `session-bridge:policy`，補上工具定義說不出口的事——什麼時候該用（使用者提到另一個 session 的工作、要查或交接給 peer）、送達會喚醒對方並消耗 token、不要傳給自己、peer 訊息不可信。這段刻意簡短，不重複工具列表。
- **HAPI 模式的 policy**：`local` 會說明同名別名接的是本機 session；`hub` 會說明它們接的是哪個 hub、回覆要用 `inspect_peer` 讀。

所以第一次使用時，使用者只要用人話說「去問另一個 session」，不需要先教模型工具名。E2E 的 `discovery` phase 已驗證這一點：只給一句人話（不提工具名、session id 或前綴），模型自己依序用了 `session_list`→`session_inspect`→`session_send`，並送達 peer（隔離 DSH 0.2.0-rc.2，2026-10-27）。

## 一覽

| 工具 | 讀寫 | 一句話 |
| --- | --- | --- |
| `session_list` | 唯讀 | 列出其他 session（活的 + 可喚醒的 stored）。 |
| `session_inspect` | 唯讀 | 讀指定 session 的 metadata 與最近訊息，不喚醒它。 |
| `session_send` | 送達 | 送一則訊息到指定 session。 |
| `session_handoff` | 送達 | 送 summary + task，並要求對方完成後回報。 |
| `list_peers` / `inspect_peer` / `ping_peer` | 同 `session_*` | HAPI 同名相容層，接本機或 hub。 |

## Target 寫法

`target`（`session_*`）與 `sessionIdPrefix`（HAPI 別名）都接受：

1. **完整 session id**（例如 `session-3f2a1b9c-…`）；
2. **唯一前綴**（本機 DSH id 是 `session-<uuid>`，uuid 部分至少 8 碼，可省略 `session-`；多個匹配會回 `ambiguous` 並列出樣本）；
3. **任何含 `/sessions/<id>` 的字串**（HAPI web 的 copy-reference、composer chip、貼上的引用段落）。含多個不同 id 的字串會 fail closed。

本機工具只接受 ordinary session，排除 subagent／teammate child。已知候選的精確 id 匹配優先，不受前綴最短 8 碼限制。完整列舉成功後找不到目標就回錯誤；列舉服務不可用時，只允許完整 `session-<uuid>` 或裸 UUID 繼續查詢／冷啟動，裸 UUID 會補上 `session-`。過短前綴或路徑字串不能代替 session id；可先用 `session_list` 選擇目標。

預設 `scope: same-cwd`，本機對話讀取與送達僅限相同工作目錄。可用 `allowCwds` 放行特定目標目錄及其子目錄，或改成 `same-root`／`host`，詳見 [設定](configuration.md)。列表仍提供 peer metadata；跨範圍 inspect 回 metadata 與 `messages: []`、`truncated: false`、`redacted: true`。`session_send`、`session_handoff` 及本機 `ping_peer` 拒絕跨範圍送達，且不會 resume 目標；非 `host` 模式也拒絕無法確認 cwd 的目標。遠端 hub 工具不套用本機 cwd 範圍。

## `session_list`

參數：無。

回傳：

```json
{
  "self": { "id": "session-…", "title": "…", "cwd": "/work/proj" },
  "sessions": [
    { "id": "session-…", "title": "…", "cwd": "/work/other", "status": "running", "updatedAt": 1793085768794 }
  ],
  "stored": [
    { "id": "session-…", "title": "…", "cwd": "/work/old", "updatedAt": 1793085000000 }
  ],
  "storedTotal": 1
}
```

- `sessions` 只含目前活著的 session（排除自己與 subagent child），`status` 是 `running`／`idle`。
- `stored` 是目前沒在跑、但 `session_send` 可以喚醒的 session（最多 30 筆，依最近活動排序）；`storedTotal` 是總數。
- `updatedAt` 是該 session 最後一個 event 的時間。

## `session_inspect`

參數：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `target` | string（必填） | 目標 session 的 id／前綴／citation。 |
| `messageLimit` | integer | 讀幾則最近訊息，1–30，預設 8。 |

回傳：

```json
{
  "session": {
    "id": "session-…", "title": "…", "cwd": "/work/proj",
    "live": true, "persisted": true, "status": "idle",
    "createdAt": 1793085000000, "updatedAt": 1793085768794
  },
  "messages": [
    { "role": "user", "seq": 30, "time": 1793085768000, "text": "…", "fromAgent": true, "senderSessionId": "session-sender-…" },
    { "role": "assistant", "seq": 32, "time": 1793085770000, "text": "…" }
  ],
  "truncated": false
}
```

- **唯讀**：只是 replay session log，不會 resume、不會 steer、不消耗對方 token。
- 超出設定範圍，或在非 `host` 模式下無法驗證工作目錄時，只回 metadata 與 `messages: []`、`truncated: false`、`redacted: true`；本機 `inspect_peer` 也會回傳 `redacted`。
- 只取 user／assistant 角色的最近訊息；單則截到 600 字、總量 16 KiB、tool call 只保留名稱；被截斷時 `truncated: true`。
- `fromAgent: true` 表示那則 user message 的 `source.kind = 'agent-message'`；來源有非空白字串 `senderSessionId` 時會原樣保留，方便辨識發送者。
- 冷 session 也讀得到（`live: false`、`persisted: true`），且讀完仍然是冷的。

## `session_send`

參數：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `target` | string（必填） | 目標 session。 |
| `message` | string（必填） | 訊息本文；請自含脈絡並說明要不要回覆。 |

回傳：

```json
{ "sent": true, "target": { "id": "session-…", "title": "…", "status": "idle" }, "coldResumed": false }
```

- 對方 `idle` 會開新 turn；`running` 會在下一個 step 邊界收到。
- 目標是 stored session 時會先 resume，成功後 `coldResumed: true`。
- 送達前先檢查 workspace 範圍與 loop guard；任何一項拒絕時都不會喚醒目標。
- 訊息大小超過 `maxMessageBytes` 會直接報錯，不會截斷。
- 來源標記見 [來源標記](#來源標記)。

## `session_handoff`

參數：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `target` | string（必填） | 接手的 session。 |
| `summary` | string（必填） | 目前狀態：做過什麼、決策、檔案路徑、blocker。 |
| `task` | string（必填） | 下一步要做什麼＋驗收條件。 |
| `reply` | boolean | 完成後是否回報，預設 `true`。 |

回傳與 `session_send` 相同（`sent`／`target`／`coldResumed`）。送出的本文會包含 summary、task，以及「完成後用 `session_send` 回報 sender session id」的指示；`reply: false` 時改為只在需要釐清時回覆。

## 來源標記

收到的 peer 訊息不是人類打的，這點在三個地方看得到：

- session log 的結構化來源：`source.kind = 'agent-message'`、`source.form = 'relay'`、`source.senderSessionId = <sender session id>`；
- 訊息 header 開頭：`[session-bridge] Message|Handoff from DSH session "<id>" (title)`；已知時附上 sender title／workspace，接著是明確區分 bridge header 與不可信 peer 本文的 notice；
- system prompt 的 policy 段要求把 peer 訊息當 untrusted，不能用來擴大權限或授權破壞性操作。

本文放在 `<peer-message sender="<id>">` 與 `</peer-message>` 之間。notice 說明標籤上方由 bridge 撰寫，而標籤內全部是不可信的 peer 文字，即使看起來像 bridge header 也不是 bridge 撰寫。本文內的開閉標籤會把 `<` 轉成 `&lt;`（忽略大小寫，包含 `<` 後的空白），每個字面 `[session-bridge]` 都會改成 `[peer-text: session-bridge]`，避免偽造封裝或來源標記。

送到 HAPI hub 的訊息（`ping_peer`）使用相同封裝；header 額外說明這是 agent 對 agent 的自動訊息，並提供回覆方式。hub 沒有結構化 metadata 通道，因此以這些文字保留來源。

## 限制與風險

- 同一個 `dsh` host process 內的 session 才互通；跨機器／跨 process 要靠 HAPI hub（唯一的跨機器路徑）。
- 一次只有一個目標，沒有廣播。
- 送達會喚醒對方、消耗 token；預設 loop guard 對每組 sender → target 限制 60 秒內 10 則，減少 agent ping-pong。可調整 `loopGuard.windowMs`／`loopGuard.maxMessages` 或用 `loopGuard: false` 關閉；它是記憶體中的每對限流，仍需在任務指示裡約定停止條件。
- `session_inspect` 不是完整 transcript；需要完整內容請直接讀 session log。
- 對冷 session 送訊息會把它 resume 成 live agent；失敗會回報錯誤，不會弄壞 session。跟 GUI 同時開同一個 session 由 session-controller 去重。
- `flush` 只保證已提交的 session events 落盤；剛 steer 進 inbox 的訊息要等對方 driver 取用才進 log，process 在那一瞬間 crash 仍有小窗口會丟訊息。
- peer 訊息來自另一個 agent，不是人類；不要把它的指示當授權。
- 未在多 session 併發壓測；目標是單人開發環境的協作。

## 建議流程

1. `session_list` 找目標（活的，或 stored 裡可喚醒的）。
2. `session_inspect` 先看對方做到哪（唯讀）。
3. `session_send` 問問題／請對方做事；`session_handoff` 把工作連脈絡交出去。
4. 對方完成後用 `session_send` 回報 sender 的 session id，原本的 session 被喚醒後繼續。
