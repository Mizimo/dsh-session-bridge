# E2E 驗證工具

驗證內容與驗證矩陣見 [`docs/testing.md`](../docs/testing.md)；這裡只說明怎麼操作測試床。

這組腳本在**隔離的 DSH instance** 上驗證 session-bridge：獨立 `DSH_HOME`、loopback-only 測試 port、不動使用者的主 `dsh web` 服務。

## 前置條件（測試機上）

- 已安裝 `dsh` 0.2.x、`pnpm`、`setsid`、Node 22+。未設定 `DSH_BIN` 時，腳本用 `command -v dsh` 尋找 PATH 上的執行檔；找不到或不可執行時，需指定 `DSH_BIN=/abs/path/to/dsh`。
- 測試機的 dsh 安裝需允許 loopback `/api` 呼叫；本專案既有測試床使用 local auth patch，stock 安裝則按下方說明取得 `DSH_WEB_COOKIE`。
- 提供 provider 憑證：隔離 home 尚無憑證時，腳本會從 `~/.dsh/.credentials.yaml` 複製一份（mode 600）；來源也不存在時會停止並報錯。
- `discovery` 的 A 在 `$TEST_BASE/workspace`，B 在其 `login-page-<token>` 子目錄，刻意測試跨 workspace 尋找 peer。隔離 profile 的 `session-bridge` row 需設 `scope: host`；也可保留 `same-cwd` 並用 `allowCwds` 放行 `$TEST_BASE/workspace` 的實際絕對路徑。這是測試 profile 的設定，產品預設仍是 `same-cwd`。
- （只給 `hapi` phase）測試機上有既有的 HAPI hub（`@twsxtd/hapi` 0.30.x，loopback），且 DSH instance 以 hub 模式載入 plugin：profile row `config: {scope: host, hapiCompat: hub, hapiHub: {apiUrl}}`，`CLI_API_TOKEN` 由 `start-test-instance.sh` 從 mode-600 env 檔帶入（不要寫進 YAML／log）。另需一個**自己的、拋棄式** HAPI `dsh` session（`HAPI_TEST_SESSION_ID`），不要對其他使用者的 HAPI session 送訊息。

## 流程

安裝 bundle 後、重啟前，在隔離 profile 的 `$TEST_BASE/home/profiles/web/cordis.patch.yml` 合併以下 row 設定；已有 `hapiCompat`／`hapiHub` 時保留它們：

```yaml
- id: session-bridge
  config:
    scope: host
```

`inspect`、`dialogue`、`handoff` 與 `cold` 的 session 都使用預設 workspace，本身可在 `same-cwd` 下執行；遠端 `hapi` 不受本機 cwd scope 影響。

```bash
# 1. 起隔離 instance（預設 127.0.0.1:3099、DSH_HOME=~/session-bridge-test/home）
export TEST_BASE=$HOME/session-bridge-test
./start-test-instance.sh

# 2. 把 plugin 裝進隔離 profile；安裝後要重啟（bundle 清單只在啟動時讀）
./install-plugin-bundle.sh /abs/path/to/dsh-session-bridge

# 3. 在隔離 profile 合併上方 scope: host 設定，再重啟讓 bundle 生效
./stop-test-instance.sh && ./start-test-instance.sh

# 4. 跑 phase（共八個；hapi 可選，需要 hub 設定 + 拋棄式 HAPI session）
export DSH_WEB_URL=http://127.0.0.1:3099
node bridge-e2e.mjs probe
node bridge-e2e.mjs discovery        # 只用人話，不加工具名／id／前綴
node bridge-e2e.mjs inspect          # session_inspect 唯讀 + 8 碼前綴解析
node bridge-e2e.mjs dialogue
node bridge-e2e.mjs handoff
node bridge-e2e.mjs cold-prepare
./stop-test-instance.sh && ./start-test-instance.sh   # 讓所有 session 變冷
node bridge-e2e.mjs cold             # 先 inspect 冷 session（不得喚醒）再送出喚醒
# hapi phase：source token env（CLI_API_TOKEN/HAPI_API_URL）後
export HAPI_TEST_SESSION_ID=$(cat "$TEST_BASE/logs/hapi-test-session.id")
node bridge-e2e.mjs hapi

# 5. 收尾
./stop-test-instance.sh
rm -rf "$TEST_BASE"   # 整個隔離 home/workspace/logs 都是拋棄式的
```

`probe` 驗證 plugin 真的載入（會呼叫 `session_list`）；`discovery` 只給人話（不提工具名、session id、前綴），驗證模型能自己找 peer、先唯讀 inspect、再送訊息；`inspect` 驗證 `session_inspect` 的唯讀讀取、前綴解析、`fromAgent` 來源標記；`dialogue` 驗證雙向送達與 log 來源標記；`handoff` 驗證交接 body 與回報；`cold-prepare` 儲存冷啟動測試的目標 id，提示操作者重啟；`cold` 驗證重啟後能「先讀不喚醒、再送喚醒」冷 session 並收到回覆；`hapi` 驗證 `list_peers`／`inspect_peer`／`ping_peer` 對真 HAPI hub 的讀取與送達（並直接查 hub API 驗證 `[session-bridge]` 來源前綴與 sender id）。phase 會印進度／驗證證據，失敗會 exit 1；`cold-prepare` 將目標寫入 state JSON。

`testbed-notes.md` 是驗證時累積的測試床筆記（架構、API wire 格式、踩過的坑），重跑前值得先看。

## 安全界線

- 腳本預設拒絕 3080（DSH web 常見主服務 port），也拒絕在已被佔用的 port 啟動；stop 會用 port／`DSH_HOME`／cwd 三重確認 PID 才 SIGTERM，不會 `pkill dsh`。
- 只寫入 `TEST_BASE` 底下的隔離 `DSH_HOME`；主 `~/.dsh` 只用於讀取並複製 provider 憑證，不會被修改。
- 不同機器可直接用（改 `TEST_BASE`／`TEST_PORT`／`DSH_BIN`）；同機多個測試床用不同 port 與 `TEST_BASE`。

> **Loopback auth**: stock DSH installs answer loopback requests with `401` until a browser token is exchanged. Start the instance, take the `?token=...` URL from its log, exchange it for the session cookie, and pass that cookie to the harness:
>
> ```bash
> curl -s -D headers.txt -o /dev/null -c cookie.jar "$TOKEN_URL"
> COOKIE=$(grep -i '^set-cookie:' headers.txt | head -1 | sed -E 's/^[Ss]et-[Cc]ookie:[[:space:]]*([^;]+).*/\1/' | tr -d '\r')
> export DSH_WEB_COOKIE="$COOKIE"
> ```
>
> The patched testbed install in this repo's notes answers loopback directly, so it needs no cookie.
