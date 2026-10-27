# HAPI 相容層

[HAPI](https://github.com/tiann/hapi) 有一套 peer tools：`list_peers`、`inspect_peer`、`ping_peer`。本 plugin 註冊同名工具，讓寫給 HAPI 的 prompt／skill／workflow 可以直接跑在 DSH 上，也可以真的接到一個 HAPI hub。

## 模式

`hapiCompat` 決定別名工具接到哪裡：

| 模式 | 別名接什麼 | 何時用 |
| --- | --- | --- |
| `auto`（預設） | 有 `hapiHub` 設定或 `HAPI_API_URL` + `CLI_API_TOKEN` 就 `hub`，否則 `local` | 一般情況。 |
| `local` | 本機 DSH session（跟 `session_*` 同一批目標） | 沒有 HAPI hub，但想沿用 HAPI 寫法。 |
| `hub` | 真正的 HAPI hub REST API | DSH 要跟 HAPI 上的 session 對話。 |
| `false` | 不註冊別名，只留原生 `session_*` | 不想讓模型看到兩套名字。 |

`HAPI_DISABLE_PEER_TOOLS=1|true|yes` 時也不註冊（跟 HAPI 自己的 kill switch 一致）。

hub mode 需要的設定：

```yaml
- id: session-bridge
  config:
    hapiCompat: hub
    hapiHub:
      apiUrl: http://127.0.0.1:3006
      # accessToken: 建議改用 CLI_API_TOKEN
```

完整欄位與環境變數見 [設定](configuration.md)。hub client 建立失敗（缺 token／URL）時會印 warning 並退回 `local` 別名，不會擋開機。

## 工具語意

`hub` 模式的行為對齊 HAPI：

- id 以**唯一前綴**解析；撞號回 `ambiguous`，找不到回 `not_found`。
- `list_peers` 依 `updatedAt` 新到舊排序，排除自己（`HAPI_SESSION_ID`），預設 30、上限 100。
- `inspect_peer` **唯讀**，不會 resume；回傳 metadata + 最近訊息文字。文字先合併空白，每則超過 1200 字元時截斷並加省略號；任一回傳訊息被截斷時，頂層 `truncated` 為 `true`，否則為 `false`。
- `ping_peer` 對 inactive session 先 `POST /api/sessions/:id/resume`，再輪詢等 active（2 秒間隔、最多 60 秒；pi session 另外等 `piSessionId` 出現），最後送訊息。
- 錯誤分型：`bad_args`、`disabled`、`auth_failed`、`unavailable`、`not_found`、`ambiguous`、`resume_failed`、`timeout`、`send_failed`。連線失敗或 HTTP 5xx 回 `unavailable`；401／403 或認證交換失敗回 `auth_failed`；呼叫端取消回 `disabled`。
- 送訊息用穩定的 `localId`；hub 回 409 `session_inactive` 時會重新確認 active 與 Pi 就緒狀態再送一次。每次 resume 後都會重新等待 `piSessionId`。

## Wire（hub 模式用到的 API）

| 端點 | 用途 |
| --- | --- |
| `POST /api/auth` `{accessToken}` → `{token}` | 換 JWT（4 小時），client 會 single-flight 快取，401 時重認證一次。 |
| `GET /api/sessions?limit=&order=updatedAt` | list peers；namespace 由 token／`extraHeaders` 決定。 |
| `GET /api/sessions/:id` | 單一 session metadata（`active`、`metadata.name/path/flavor/lifecycleState/summary`）。 |
| `GET /api/sessions/:id/messages?limit=` | 最近訊息（預設 50、上限 200）；只取 user／assistant 文字。 |
| `POST /api/sessions/:id/resume` `{}` | 喚醒 inactive session；回 `{type:'success'}` 或錯誤。 |
| `POST /api/sessions/:id/messages` `{text, localId}` | 送訊息；session 必須 active。 |

以上用到的 wire 已跟 HAPI 0.31.2 原始碼比對，在 0.30.7 hub 上實測相同。

## 來源標記

hub 只收純文字，沒有 metadata 通道。`ping_peer` 送出的本文固定以下面這行開頭：

```
[session-bridge] Agent message from DSH session "session-…" (title)
Sender workspace: /work/proj
This is an automated agent-to-agent message, not a message from the human user. …
```

後面才是使用者訊息本文。收到的一方可以從文字認出這是 agent 傳的；DSH session log 裡的原生 relay 則同時有結構化 `source` 標記。

## 限制

- **單向送達**：DSH session 本身不是 HAPI hub 上的 session，HAPI 那邊不能用 `ping_peer` 回呼；回覆要由 DSH 用 `inspect_peer` 去讀對方 conversation 尾端。
- 唯一例外：DSH 跑在 `hapi dsh` 底下（有 `HAPI_SESSION_ID`）時，訊息會附上回覆位址，對方可以 `ping_peer` 回呼，等於雙向。
- hub 只收純文字；附件、metadata、圖片不支援。
- 對 inactive session 送訊息會把它 resume；需要對應 machine 的 runner 在線。對別人的既有 session 送訊息前請自己確認。
- 一次只有一個目標；沒有廣播。

測試方式與驗證過的版本見 [測試](testing.md)。
