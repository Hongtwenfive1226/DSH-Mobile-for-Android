# P2 — 公网远程访问安全方案

> ✅ **已实测验证（Tailscale 路线）**：转发器 `forwarder.mjs` 监听
> `YOUR_TAILSCALE_IP:8787 → 127.0.0.1:3080`，Host 重写为 loopback 并抹除 Origin/Sec-Fetch-*。
> 已验证：HTTP RPC（`host.describe`/`workspace.list`/`session.list`）、两条下行 WebSocket（`events.mux`/`events.host`）、
> 带 Origin 的浏览器模拟请求，全部经 Tailscale 路径 200 通过。

## 结论摘要

- DSH 只能绑 `127.0.0.1`（CLI 拒绝 `0.0.0.0`，schema 只接受 `127.0.0.1`/`0.0.0.0`）。
- 因此手机不能直连桌面 Tailscale IP，必须有一个**桌面侧转发器**：绑 Tailscale 网卡、转发到 loopback、并把 Host 重写为 loopback（否则 fence 403）。
- 本方案零依赖，`forwarder.mjs` 即该转发器；仅绑 Tailscale IP，局域网不可达。

## 目标与前提

让手机（React Native App，走公网）安全连上运行在桌面机的 `dsh web` 宿主。
DSH v1 的 `/api` 只有 **trust-fence（可达性策略）**，**没有认证、没有 TLS**。因此公网接入必须由一层「TLS + 认证」的边界来补，DSH 宿主本身保持绑定 `127.0.0.1` 不变。

## 已实测确认的 fence 行为

| Host 头 | 结果 |
|---|---|
| `127.0.0.1:3080`（loopback） | 200 通过 |
| `192.168.1.50:3080`（LAN 非信任） | 403 拒绝 |
| `evil.example.com`（非信任权威） | 403 拒绝 |

结论：公网接入有且仅有两条路——**A. 反代把 Host 头重写成 loopback**（fence 看到 `127.0.0.1`，无需改 DSH 配置）；**B. 把公网权威声明进 `trustedHosts`**（`--trusted-host` 或 cordis 配置）。

## 推荐方案 A：反向代理 + TLS + 认证（零 DSH 改动）

反向代理在宿主机器上监听公网端口，终结 TLS 与认证，转发到 `127.0.0.1:3080`，并把 Host 头重写为 loopback。

### nginx（默认 `proxy_pass` 即把 Host 重写为上游，天然满足 fence）

```nginx
server {
    listen 443 ssl;
    server_name your.example.com;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    # 认证：基础认证 / 或改用 OAuth2 网关
    auth_basic "DSH";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3080;   # 默认 proxy_set_header Host $proxy_host → 127.0.0.1:3080
        proxy_http_version 1.1;              # WebSocket 升级必需
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;            # 长连接事件流不能断
    }
}
```

### Caddy（注意：Caddy 默认保留原始 Host，需显式重写）

```caddyfile
your.example.com {
    basic_auth {
        <user> <bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:3080 {
        header_up Host 127.0.0.1:3080     # 关键：让 fence 看到 loopback
    }
}
```

## 方案 B：声明公网权威（`--trusted-host`）

若不想重写 Host，可启动时声明权威：

```bash
dsh web --host 127.0.0.1 --trusted-host your.example.com
```

并在反代中保留原始 Host（`proxy_set_header Host $host;`）。这样 fence 用 `trustedHosts` 放行。**但认证/TLS 仍然要靠反代**——fence 不是认证。

## 零配置隧道（临时/个人用，最快）

- **Tailscale**：手机与桌面加入同一 tailnet，直接连 `http://<tailscale-ip>:3080`。仍需 `--trusted-host <tailscale-ip>`（fence 会拦非 loopback 的 Host）。Tailscale 自带端到端加密与访问控制（Meshnet ACL），但 DSH 那层仍无认证。
- **Cloudflare Tunnel（cloudflared）**：公网 HTTPS 域名 → cloudflared 转发到 `127.0.0.1:3080`。默认保留公网 Host，需 `httpHostHeader: 127.0.0.1:3080` 重写以满足 fence；配 Cloudflare Access 提供认证。

## 必须补齐的「认证层」（无论 A/B）

fence 只防「意外可达」，不防「知道地址的人」。公网部署至少要加其中之一：
1. 反代层 Basic Auth / OAuth2 Proxy / Cloudflare Access / Tailscale ACL（**零 DSH 改动，推荐先做这个**）；
2. 或在 DSH 的 `/api` 与 WS 握手上加 token 认证（**改源码，正解**，才能真正放开 `--host 0.0.0.0`）。

## React Native 客户端在公网下的注意点

- RN 的 fetch/WS 不发 `Origin`/`Sec-Fetch-Site`（与本次 Node spike 同姿势，已实测通过），fence 按 Host 头权威判定 → 满足 A 或 B 即可。
- 必须走 `wss://`（HTTPS 反代后 WS 自动升级为 wss）。
- 移动网络切换/弱网下要正确实现重连（浏览器默认退避参数见 protocol.md §8）。
- 宿主桌面能力（`host.openPath`、`host.pickDirectory` native）在手机上不可用，需降级到 `host.listDirectory`（browse）或隐藏。

## 建议的 P2 执行顺序（拍板后我协助）

1. 你在公网/域名环境选一个：Tailscale（最快）或 自有域名 + Caddy/nginx + 反代认证。
2. 我用 `DSH_BASE=https://你的域名` 跑同一个 spike，验证 Host 重写 + fence + TLS 全链路。
3. 通过后，把 spike 的连接层迁到 RN 最小 App（P3）。
