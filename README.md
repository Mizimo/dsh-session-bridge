<div align="center">

<img src="docs/assets/banner.svg" width="100%" alt="兩個 session 之間的一座橋">

# dsh-session-bridge

**讓 DSH 裡不同 session 的 agent 互相傳訊息、讀對方的進度、把工作交棒。**

Host-only bundle。沒有 client 半，沒有 build step。<br>
裝進 profile 之後，每個一般頂層 session 的 agent 就多一組可以直接對話的工具。

![DSH 0.2.x](https://img.shields.io/badge/DSH-0.2.x-5a64a3?style=flat-square&labelColor=313157)
![HAPI 0.30/0.31](https://img.shields.io/badge/HAPI-0.30%2F0.31-6a89d5?style=flat-square&labelColor=313157)
![License MIT](https://img.shields.io/badge/license-MIT-6a89d5?style=flat-square&labelColor=313157)
![CI](https://img.shields.io/github/actions/workflow/status/Mizimo/dsh-session-bridge/ci.yml?style=flat-square&label=CI&labelColor=313157)

</div>

> 多開幾個 session 各自做事時，它們看得到自己的工作，卻看不到彼此。這個 bundle 讓 agent 用工具找 session、讀最近的對話、把工作連脈絡交棒。

## 它可以做什麼

| 工具 | 用途 |
| --- | --- |
| `session_list` | 列出其他 session：活著的，加上可以喚醒的 stored |
| `session_inspect` | 唯讀讀取最近訊息；不會喚醒對方，也不消耗對方 token |
| `session_send` | 送一則訊息；對方 idle 會開新 turn，running 則在下一個 step 邊界收到 |
| `session_handoff` | 把 summary 和下一步一起交出去，預設要求對方完成後回報 |

`session_inspect` 對冷 session 也有效；`session_send` 會把它 resume 成 live agent（回傳 `coldResumed: true`）。收到的訊息在 session log 裡帶 `agent-message`／`relay` 來源；`[session-bridge]` header 下方以 `<peer-message sender="...">...</peer-message>` 封裝不可信的 peer 本文，本文內的 bridge marker 會轉義。

預設和 v0.2.1 一樣，同一個 host 上的一般 session 都能互相讀取與送達。需要時可以選用 workspace 範圍（`scope: same-cwd`／`same-root`，搭配 `allowCwds`）與 loop guard（`loopGuard: true`），見 [設定](docs/configuration.md)。

需要 HAPI 的 `list_peers`／`inspect_peer`／`ping_peer` 時，同一組名字可以接本機 DSH session，也可以接真正的 HAPI hub；模式和限制見 [HAPI 相容](docs/hapi.md)。

## 安裝

```sh
dsh plugin --profile web add github:Mizimo/dsh-session-bridge#v0.2.2
```

裝完**重啟該 profile 的 dsh process**，開一個新 session，確認 agent 有 `session_list` 就生效了。

> DSH Desktop 的 `desktop` profile 由 GUI 管理，CLI 會拒絕；Desktop 請從內建插件管理介面安裝。

## 快速開始

在一個 session 裡對 agent 說：

> 用 `session_list` 看看其他 session，挑正在改登入頁的那個，用 `session_inspect` 讀它最近的進度，再問它能不能接手。

```
session A ── session_send ──▶ session B
          ◀── session_send ──
```

要交接工作時改用 `session_handoff`，把目前狀態和下一步一起送出去。

## 文件

| 文件 | 內容 |
| --- | --- |
| [設定](docs/configuration.md) | row config、環境變數、kill switch、憑證安全 |
| [工具參考](docs/tools.md) | 每個工具的參數、回傳、錯誤與限制 |
| [HAPI 相容](docs/hapi.md) | 模式、hub 設定、wire 行為、單向限制 |
| [運作原理](docs/architecture.md) | 送達／讀取／冷啟動，程式結構與設計取捨 |
| [測試](docs/testing.md) | 單元測試、E2E 驗證矩陣與重跑方式 |

## 相容性

- **DSH 0.2.x**：驗證過 0.2.0-rc.2 CLI 與 0.2.1-rc.2 Desktop；v0.2.2 在 DSH 0.2.1-rc.2（npm `latest`）的 web profile 上跑過 E2E；`peerDependencies` 是 `>=0.2.0-rc.1 <0.3.0`。
- **HAPI 0.30.x／0.31.x**：用到的 REST wire 在 0.30.7 與 0.31.2 相同。
- 只跑在同一個 `dsh` host process 內的 session；跨機器要經過 HAPI hub。

## 授權

[MIT](LICENSE)

<div align="center"><sub>配色與版面取自 <a href="https://github.com/Mizimo/whale-girl-visual-language-v4">大肥魚視覺與語言庫</a> 的靛藍組；本 repo 不含角色素材。</sub></div>
