# 隔離 DSH 測試床 — 筆記（v0.2，2026-10-27）

這份筆記記錄 `dsh-session-bridge` 的 E2E 測試床怎麼搭、API 怎麼打、踩過哪些坑。
數字與路徑是**慣例**（可用環境變數覆寫），不是特定機器的設定。

## 1. 架構

| | 主 DSH service（不要動） | 隔離測試 instance |
| --- | --- | --- |
| 用途 | 使用者每天在用的 | 只跑測試，整個目錄可刪 |
| `DSH_HOME` | `~/.dsh` | `$TEST_BASE/home` |
| Profile | 使用者的 profile | `web`，首次啟動由內建模板建立 |
| 位址 | 例如 `127.0.0.1:3080` | `$TEST_HOST:$TEST_PORT`（預設 loopback，port 遠離主服務） |
| 啟動 | systemd/launchd，長期 | `e2e/start-test-instance.sh`，detached process |
| Process 清理 | 不要碰 | `e2e/stop-test-instance.sh`（port + `DSH_HOME` + cwd 三重驗證後 SIGTERM） |

硬規則：

- 測試只寫 `$TEST_BASE`，不讀寫主 `~/.dsh`（唯一例外：啟動時複製一份 provider 憑證到隔離 home）。
- 不改主服務的 port、service unit、防火牆；測試 instance 只 bind loopback。
- 測試腳本拒絕在 port 3080 啟動（DSH web 常見主服務 port），也拒絕佔用中的 port。

## 2. 隔離流程

```bash
export TEST_BASE=$HOME/session-bridge-test
export TEST_PORT=3099 DSH_BIN=/abs/path/to/dsh
./e2e/start-test-instance.sh            # 建立隔離 home、複製 credentials（mode 600）、起 web
./e2e/install-plugin-bundle.sh /abs/path/to/dsh-session-bridge
# 在隔離 profile 的 session-bridge row 設 scope: host（discovery 會跨 workspace）
./e2e/stop-test-instance.sh && ./e2e/start-test-instance.sh   # bundle 清單只在啟動時讀
```

- 需要有 provider 憑證：隔離 home 尚無憑證時，腳本從主 `~/.dsh/.credentials.yaml` 複製一份；來源也不存在時會報錯停止。
- `start-test-instance.sh` 不修改 PATH；pid 檔是 `$TEST_BASE/test-instance.pid`，port 檔是 `$TEST_BASE/test-instance.port`，log 是 `$TEST_BASE/logs/test-instance.log`。它會把 stop 腳本複製到 `$TEST_BASE/bin/stop-test-instance.sh` 並設為可執行。未設定 `DSH_BIN` 時從 PATH 找 `dsh`，找不到或不可執行時需明確設定 `DSH_BIN`。
- 同機多個測試床就用不同 `TEST_BASE` + 不同 `TEST_PORT`；不同機器可直接搬（腳本只依賴 `DSH_BIN`、`TEST_BASE`、`TEST_PORT`）。

## 3. Web API wire（本地 loopback）

測試 harness 直接打 web RPC（`$DSH_WEB_URL/api/<namespace>/<method>`），使用 local auth patch，或在 stock 安裝以瀏覽器 token 換取 `DSH_WEB_COOKIE` 後呼叫。

- `session/list`：列 session。
- `session/projections`：取 `asOfSeq`、`turnOutline`（**只留每個 turn 的最後一條 response**）、狀態。
- `session/page`：`{request:{address:{kind:'session',sessionId}, throughSeq, maxMessages}}` 取訊息頁；`throughSeq` 用 `asOfSeq`，**不要用 -1**（會回空頁）。
- `session/create`、`session/prompt`：建立／送 prompt；prompt 會排隊，harness 要等 assistant 文字出現。
- `agent/list`（或等價方法）：查 agent 是否 live。

Event 形狀（`session/page` 的 messages / `sessionQuery.readSession` 的 events）：

- `user/message` → `data.content`（字串或 content block 陣列）；agent 來源在 `data.source`：`kind:'agent-message'`、`form:'relay'`、`senderSessionId`。
- `assistant/message` → `data.message.content`（字串或陣列，需自行抽 text）。
- `session/title` → `data.title`。
- tool call 在 message content 的 `tool-call` block；tool result 在 `tool-result` block。

## 4. Plugin 載入與 bundle 規則

- package 需要 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`；manifest 的 `dsh.profile.bundles` 只在啟動時讀，**裝完要重啟**。
- `web` profile 的 plugin row 是 optional：載入失敗只印 `dsh: warning: 1 entry did not activate`，不會擋開機。驗證成敗要看「新 session 裡有沒有工具」。
- 版本檢查：`engines.dsh` 或 DSH peer 範圍要含實際 runtime（0.2.x）；不符要版本豁免（explicit risk acceptance）。
- 安裝來源：`file:` 本機路徑、registry 版本、或 git spec（`github:owner/repo#tag`）。git spec 安裝後 profile `node_modules` 會有該 package，bundle 由 package name 解析。
- 原始碼 bundle 若要 build 才會有 entry，要先 `pnpm install && pnpm run build`；本專案是純 JS，不用 build。

## 5. HAPI 相容層測試床

隔離 profile 先為本機 `discovery` 設定 `config: {scope: host}`：A 使用 `$TEST_BASE/workspace`，B 使用其 `login-page-<token>` 子目錄，預設 `same-cwd` 會隱藏 inspect 本文並拒絕送達。若只想放行測試 workspace，可改用 `allowCwds: [<TEST_BASE 的實際絕對路徑>/workspace]`；YAML 不會自動展開 `$TEST_BASE`。其他本機 phase 使用相同 cwd，遠端 hub 目標不受此 scope 限制。

- 測試機上有既有的 HAPI hub（`@twsxtd/hapi` 0.30.x，通常 loopback）；`GET /api/sessions` 未帶 token 應回 401。
- Token 從 HAPI 自己的設定讀（例如 `~/.hapi/settings.json` 的 `cliApiToken`）：**只放到環境變數或 mode-600 env 檔**，不要寫進 YAML、log、commit。
- 同時跑 `hapi` 時，DSH instance 以 hub 模式載入：profile row `config: {scope: host, hapiCompat: hub, hapiHub: {apiUrl: 'http://127.0.0.1:<hub port>'}}`；`CLI_API_TOKEN` 由啟動腳本帶入 host process。
- 送訊息對象**必須是自己建的拋棄式 HAPI `dsh` session**，不要對其他人的 HAPI session 送訊息或讀訊息。
- HAPI `dsh` provider（0.30.x）會 spawn 名為 `dsh-acp-demo` 的 binary；沒有的話在 workspace 放一個 shim 指向 `dsh --profile acp` 即可：
  `#!/bin/sh` + `exec npx dsh --profile acp`。這是 HAPI 側的設定，不是 plugin 需求。
- 驗證：`list_peers` 看得到目標、`inspect_peer` 讀 messages、`ping_peer` `delivered:true`；再直接打 hub API
  `GET /api/sessions/<id>/messages?limit=200` 驗證訊息以 `[session-bridge] Message from DSH session "<id>"` 開頭、sender id 正確；peer 本文封裝在 `<peer-message sender="<id>">...</peer-message>` 內。
- 收尾：停 instance、殺 tmux/`hapi dsh` 程序；hub 上的 session 記錄停止後變 inactive（HAPI 未提供 archive API 時由 UI 處理），最後才 `rm -rf $TEST_BASE`。
- 動 HAPI 前先讀它的 `/api/auth`、`/api/sessions`、`/api/sessions/:id`、`/messages`、`/resume` wire；本專案已與 0.31.2 原始碼比對，用到的 route 在 0.30.7 相同。

## 6. Harness 踩過的坑

1. **`turnOutline` 只有最後一條 response。** 對方訊息若在同一 turn 內被消費，中間步驟（例如 `SENT-A`）不會出現在 turnOutline——要輪詢 `session/page` 的 assistant 訊息文字（本專案 `waitForAssistantText`）。
2. **不要一看到證據就斷言。** relay 進來後，下一步 assistant 輸出可能還沒 commit；等「assistant seq > inbound seq」再斷言。
3. **工具結果要等 commit。** `session_send` 的 `coldResumed` 之類結果可能在頁面快照之後才落地；用輪詢。
4. **`throughSeq:-1` 回空頁**，永遠用 `session/projections` 的 `asOfSeq`。
5. **兩個 writer 一個 profile。** 安裝/移除 bundle 只能一個 agent 做，裝完重啟；不要一邊跑測試一邊改 profile。
6. **憑證副本**：隔離 home 的 credentials 是敏感檔（mode 600），不列印、不複製到別處，跟 `$TEST_BASE` 一起刪。
7. **成本**：每個 roundtrip 會喚醒模型（deepseek-flash 約 0.3–0.7k tokens/回）；prompt 要短。
8. **清理**：`stop-test-instance.sh` 先確認 port 空、主服務仍健康，再 `rm -rf "$TEST_BASE"`（只刪這條路徑）。

## 7. v0.2 E2E 結果

既有隔離 instance + 真實 HAPI hub 的驗證紀錄包含八個 phase（`probe`、`discovery`、`inspect`、`dialogue`、`handoff`、`cold-prepare`、`cold`、`hapi`），全部 PASS；`cold-prepare` 後需要重啟 instance。
詳細驗證內容與重跑指令見 [`docs/testing.md`](../docs/testing.md)，測試床操作見 [`e2e/README.md`](README.md)。
