# dsh-session-bridge

[![test](https://github.com/Mizimo/dsh-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Mizimo/dsh-session-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

讓同一個 DeepSeek Harness（DSH）host 上**不同 session 的 agent 互相傳訊息、讀對方進度、交接工作**。

DSH 裡每個終端／GUI 分頁是獨立 session，彼此看不到對方。這個 bundle 讓 agent 用工具直接找 session、讀最近的對話、送訊息過去，需要時還能把工作連脈絡一起交棒。另外附一層可選的 **HAPI 相容介面**：同樣的 `list_peers` / `inspect_peer` / `ping_peer` 名稱，可以接本機 DSH session，也可以接真正的 HAPI hub。

## 功能

- **四個原生工具**：`session_list`、`session_inspect`（唯讀、不喚醒）、`session_send`、`session_handoff`。
- **冷 session 也能用**：`session_inspect` 讀得到已結束的 session；`session_send` 會把它 resume 成 live agent。
- **來源可辨識**：收到的訊息在 session log 裡是 `agent-message` / `relay` 並帶 `senderSessionId`；訊息本文開頭也有 `[session-bridge]` 標記。
- **HAPI 相容**：HAPI 的 peer tools 可用同一組名字接本機 DSH，或透過 HAPI hub REST API 跟 HAPI session 對話。
- **彈性 target**：完整 id、唯一前綴、或任何含 `/sessions/<id>` 的引用字串都可以。

## 安裝

```sh
dsh plugin --profile web add github:Mizimo/dsh-session-bridge#v0.2.0
```

裝完**重啟該 profile 的 dsh process**（bundle 清單只在啟動時讀）。開一個新 session，確認 agent 有 `session_list` 工具即生效。

> DSH Desktop 的 `desktop` profile 由 GUI 管理，CLI 會拒絕該 profile 的 plugin 操作；Desktop 請從內建插件管理介面安裝，`web`／`headless`／自訂 profile 用上面的 CLI。

從本機 checkout 安裝（開發用）：

```sh
dsh plugin --profile web add /abs/path/to/dsh-session-bridge
```

移除：`dsh plugin --profile web remove dsh-session-bridge`。

## 快速開始

在一個 session 裡對 agent 說：

> 用 `session_list` 看看其他 session，挑正在改登入頁的那個，用 `session_inspect` 讀它最近的進度，再問它能不能接手。

想交接工作時：

> 用 `session_handoff` 把目前狀態和下一步交給那個 session，請它完成後回報。

## 文件

| 文件 | 內容 |
| --- | --- |
| [設定](docs/configuration.md) | row config、環境變數、kill switch、憑證安全 |
| [工具參考](docs/tools.md) | 每個工具的參數、回傳、錯誤與限制 |
| [HAPI 相容](docs/hapi.md) | 模式、hub 設定、wire 行為、單向限制 |
| [運作原理](docs/architecture.md) | 送達／讀取／冷啟動／程式結構與設計取捨 |
| [測試](docs/testing.md) | 單元測試、E2E 驗證矩陣與重跑方式 |

## 相容性

- DSH **0.2.x**（驗證過 0.2.0-rc.2 CLI 與 0.2.1-rc.2 Desktop；`peerDependencies: >=0.2.0-rc.1 <0.3.0`）。
- HAPI **0.30.x / 0.31.x** hub（用到的 REST wire 在 0.30.7 與 0.31.2 相同）。
- Host-only plugin，無 client 半、無 build step；細節見 [運作原理](docs/architecture.md)。

## 授權

[MIT](LICENSE)
