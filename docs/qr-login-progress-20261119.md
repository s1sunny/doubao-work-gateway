# 扫码登录移植进度（2026-11-19，暂停）

> 状态：**已实现并接入面板，链路卡在上游 2046，暂停真人验证**（避免触发风控）。
> 手头可用路径：**手动 Cookie 按字段接入**（本次同时优化，见 §4）。

## 1. 已完成

| 项 | 状态 | 证据 |
|---|---|---|
| 取码 `GET /passport/web/get_qrcode/` | ✅ 通 | `error_code=0`，返回 base64 PNG + token（后缀 `_lf`）|
| 二维码内容 | ✅ 是登录码 | pyzbar 解码 → `zjsms.com/<id>/` → 302 到 `/flow-account/scan-login?...device_platform=web&qr_source_aid=497858&token=<32hex>_lq` |
| 轮询 `check_qrconnect` | ✅ 通（需两处修正） | 见 §2 |
| 扫码事件 | ✅ 已识别 | `14:45:14 status="scanned"` |
| 扫码后确认 | ❌ 上游 2046 | `error_code=2046 为保证账号安全，暂不支持此操作` |
| 自动换码（60s） | ✅ 通 | 60s 到点自动出下一张码（14:38:46 实测）|
| 入库（收 Set-Cookie → importCookies） | ⏳ 未走通 | 依赖 confirmed |

## 2. 两个关键修正（都已在代码里）

1. **必须带 `x-tt-passport-csrf-token` 头**
   缺失 → 每次轮询 `error_code=2035 非法请求`（面板表现为「扫了没反应」）。
   值取 `passport_csrf_token` Cookie（URL 解码后）。

2. **必须先建官网页会话拿 `ttwid`**
   匿名会话轮询约 6–10 次后开始 `error_code=2156 服务繁忙`；
   先 `GET https://www.doubao.com/chat/` 吸收 `ttwid`/`hook_slardar_session_id`，再取码、再轮询，
   对照实验 12 次 2s 轮询 `error_code` 全 0。整条链路 Cookie 用同一个 jar。

3. **二维码只有 60 秒**：`expire_time` 实测 `expire_in_s=60`。已实现到期自动换码（最多 5 次），面板上二维码会自己刷新。

## 3. 未解：扫完后的 2046

时间线（14:45）：

```
14:45:14  code=0   status=scanned      ← 手机扫到了
14:45:18  code=2046 为该账号安全，暂不支持此操作
（之后每次轮询持续 2046）
```

公开文案（`get_qrcode` 的 `copywriting`）写的是「请使用**抖音 APP**扫码验证」。
本次真人测试用的是**豆包 App**，2046 是否为「扫码端 App 不被接受」尚未证实。

**恢复测试时的顺序建议**（每次只做一个变量，避免风控加码）：
1. 用**抖音 App**扫同一张新码，观察是否从 `scanned` 走到 `confirmed`；
2. 若仍 2046 → 换一个未在网页端登录过的测试账号再试（排除账号级风控）；
3. 若仍 2046 → 停手，结论记为「该链路对本环境账号不可用」，只用手动 Cookie。

**风控纪律**：单次试探；出现 2156/2046 立即停 ≥10 分钟；不要连发取码。

## 4. 同时完成的：手动 Cookie 按字段接入

用户反馈：网页登录后 `sessionid` 与 `sessionid_ss` 值相同、不想自己拼 Cookie 头。

- 面板最终只保留 **`sessionid` 单字段**（经实测：只填 sessionid 即可，网关自行补 ttwid/web_id 等设备上下文；UI 已按此简化）。后端仍兼容多字段对象与整串 Cookie 两种入参。
- 后端 `cookiesFromFields()` 负责校验 + 拼装 Cookie 列表，再走 `services.importCookies({cookies, clientProfile:'web'})`。
- `sessionid` 与 `sessionid_ss` 相同是**正常现象**（字节系双写），两个都填同一个值即可；只填 `sessionid` 也能过（网关会自行访问官网补 `ttwid`、`web_id` 等设备上下文）。
- 兼容旧的整串 Cookie：`POST /api/login/cookie {cookie: "..."}` 仍可用。

## 5. 代码位置

- `native/qr-login.mjs`：取码/轮询/自动换码/收 Cookie；导出 `cookiesFromText` / `cookiesFromFields`
- `native/panel.mjs`：`/api/login/qr`、`/api/login/qr/status`、`/api/login/qr/cancel`、`/api/login/cookie`
- `public/index.html` / `public/ui.js` / `public/style.css`：登录弹窗两块 UI
- 提交：`5a5f497`、`83653ba`、`2743ede`
- 调试开关：systemd `Environment=DW_QR_DEBUG=1`（只打状态码，不打 token/cookie）