# 本 fork 的本地改动（s1sunny/doubao-work-gateway）

## 2026-11-19：面板鉴权可关闭 + 可绑定内网

- `native/gateway.mjs`：`listen()` 增加 host 参数；面板监听地址可用 `DW_PANEL_BIND` 覆盖（默认 `127.0.0.1`）
- `native/panel.mjs`：新增 `DW_PANEL_AUTH=off` 时跳过 `x-doubao-panel` 头与 Origin 校验（保留路径与 CSP）
- 用途：内网无鉴权访问管理面板（用户明确同意，风险已知）
- 模型 API 仍只监听 `127.0.0.1`

启用方式（systemd）：
```
Environment=DW_PANEL_BIND=0.0.0.0
Environment=DW_PANEL_AUTH=off
```

⚠️ 关闭鉴权后，同网段任何客户端都可操作账号/Key，仅限可信内网。
