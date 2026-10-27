# 工具參考

外掛會為每個 top-level session 的 agent 註冊工具。沒有 HAPI 相容層時是四個 `session_*` 工具；`hapiCompat` 開啟時再多三個 HAPI 同名的別名（見 [HAPI 相容](hapi.md)）。

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
2. **唯一前綴**（DSH id 是 `session-<uuid>`，給前 8 碼 uuid 或 `session-` + 8 碼都可以；多個匹配會回 `ambiguous` 並列出樣本）；
3. **任何含 `/sessions/<id>` 的字串**（HAPI web 的 copy-reference、composer chip、貼上的引用段落）。含多個不同 id 的字串會 fail closed。

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
    { "role": "user", "seq": 30, "time": 1793085768000, "text": "…", "fromAgent": true },
    { "role": "assistant", "seq": 32, "time": 1793085770000, "text": "…" }
  ],
  "truncated": false
}
```

- **唯讀**：只是 replay session log，不會 resume、不會 steer、不消耗對方 token。
- 只取 user／assistant 角色的最近訊息；單則截到 600 字、總量 16 KiB、tool call 只保留名稱；被截斷時 `truncated: true`。
- `fromAgent: true` 表示那則 user message 是另一個 agent 透過 bridge 傳的（`source.kind = 'agent-message'`）。
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

回傳與 `session_send` 相同（`sent`／`target`／`coldResumed`）。送出的本文會包含 summary、task，以及「完成後用 `session_send` 回報 sender session id」的指示。

## 來源標記

收到的 peer 訊息不是人類打的，這點在三個地方看得到：

- session log 的結構化來源：`source.kind = 'agent-message'`、`source.form = 'relay'`、`source.senderSessionId = <sender session id>`；
- 訊息本文開頭：`[session-bridge] Message|Handoff from DSH session "<id>" (title)`，下一行是 sender workspace；
- system prompt 的 policy 段要求把 peer 訊息當 untrusted，不能用來擴大權限或授權破壞性操作。

送到 HAPI hub 的訊息（`ping_peer`）沒有 metadata 通道，改用文字前綴 `[session-bridge] Agent message from DSH session "<id>"`，並明說這是 agent 對 agent 的自動訊息。

## 限制與風險

- 同一個 `dsh` host process 內的 session 才互通；跨機器／跨 process 要靠 HAPI hub（唯一的跨機器路徑）。
- 一次只有一個目標，沒有廣播。
- 送達會喚醒對方、消耗 token；互相回話可能無限 ping-pong。plugin 只限制單則大小，**沒有 hop 次數上限**，請在指示裡收斂。
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
