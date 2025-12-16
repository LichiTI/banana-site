# Gemini 工作台 v5.0 修改版（Banana）

原作者：Angela

这是一个单页 Web 应用（`banana.html` + `assets/`）+ 零依赖 Node.js 后端（`server/`），用于在 VPS 上实现：

- 用户注册/登录（Cookie 会话）
- Admin 管理员权限（首个注册用户默认为 Admin；也可用环境变量指定）
- 图片按用户落盘：`uploads/`（用户上传）、`generated/`（模型生成/拉取）
- 收藏（预设/对话/合集）独立存储且包含图片（服务端落盘，不随历史记录清理）
- 云图片库：上传/生成图片分库浏览（侧边栏「用户图库」或顶部按钮）
- 云图片库容量：默认每个用户 1GiB（上传+生成合计），Admin 不限；云图片库弹窗/侧边栏会显示用量

## 更新日志

- `v5.0`：云图片库支持管理（删除单张/清空当前/清空全部）、缩略图+懒加载、打开原图预加载相邻 2 张、用户注册登录与 Admin 权限、容量/配额显示
- `v4.9`：基础 UI/交互增强与 bug 修复

## 目录结构

- `banana.html`：前端入口
- `assets/`：前端静态资源（`styles.css`、`app.js`）
- `server/`：Node.js 后端
- `data/`：运行时数据目录（默认会自动创建，已在 `.gitignore` 中忽略）
  - `data/users/<username>/uploads/`
  - `data/users/<username>/generated/`
  - `data/users/<username>/favorites/`
  - `data/users/<username>/history/`

## 云端同步说明

- “收藏”（预设/对话/合集）：永久保存，包含图片快照（不随历史清理）
- 已移除“未收藏聊天记录”的云端同步：聊天记录仅保留在当前运行会话中；需要跨设备保留请使用“保存对话到库”（收藏）

## 用户图库（云端）

- 入口：侧边栏「用户图库」或顶部「云图片库」按钮
- 分库：`上传库 (uploads)` / `生成库 (generated)`
- 列表展示：默认显示 WebP 缩略图（点击才打开原图）
- 预加载：打开原图会自动预加载相邻 2 张（提升翻页流畅度）
- 管理：支持删除单张图片、清空当前库、清空全部（仅影响你自己的云图库，不影响已收藏内容）
- 缓存：图片通过 `/files/...` 提供，支持 `ETag/304`，浏览器会自动复用缓存
- 配额：普通用户 `1GiB`（上传+生成合计），Admin 不限；超出会提示“图库容量不足”

## 本地运行（开发/自测）

要求：Node.js 18+（建议 20 LTS）

1) 启动后端

```bash
npm start
```

默认监听：`http://0.0.0.0:3000`

2) 打开页面

- 浏览器访问：`http://127.0.0.1:3000/`（由后端托管 `banana.html` 和 `assets/`）

## 环境变量

参考：`server/.env.example`

- `PORT`：服务监听端口（默认 `3000`）
- `NODE_ENV`：`production` 时会给 Cookie 加 `Secure`（HTTPS 部署建议设置）
- `BANANA_SECRET`：签名密钥（不填会自动生成并写入 `data/secret.txt`）
- `BANANA_ADMIN_USER` / `BANANA_ADMIN_PASS`：启动时确保该管理员账号存在（可选）

## 云端部署教程（Ubuntu 22.04 / 24.04 VPS）

下面以「域名 + Nginx + HTTPS + systemd」为推荐部署方式。

### 1) 准备服务器与域名

1. 购买 VPS（Ubuntu 22.04/24.04）
2. 域名解析 A 记录指向 VPS 公网 IP
3. 开放端口：`22`、`80`、`443`

### 2) 安装 Node.js / Nginx

```bash
sudo apt update
sudo apt install -y nginx
```

安装 Node.js（推荐 NodeSource 或系统包；任选其一）：

**方式 A：NodeSource（推荐 20 LTS）**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

验证：

```bash
node -v
npm -v
```

### 3) 上传代码到 VPS

任选一种方式：

- `git clone`（如果你的仓库可访问）
- 或使用 `scp`/`rsync` 上传整个项目目录

示例（上传到 `/opt/banana`）：

```bash
sudo mkdir -p /opt/banana
sudo chown -R $USER:$USER /opt/banana
```

把本地项目内容放到 `/opt/banana`。

### 4) 安装依赖并配置环境变量

```bash
cd /opt/banana
npm install --omit=dev
```

创建环境变量文件（可选）：

```bash
cp .env.example .env
nano .env
```

至少建议设置：

- `NODE_ENV=production`
- `BANANA_ADMIN_USER=admin`、`BANANA_ADMIN_PASS=一个强密码`

说明：首个注册用户默认会成为 Admin；如果你希望固定管理员账号，使用上述环境变量更可控。

### 5) systemd 守护进程（推荐）

创建服务文件：

```bash
sudo nano /etc/systemd/system/banana.service
```

填入（按需修改路径/端口/环境变量）：

```ini
[Unit]
Description=Banana Web App
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/banana
ExecStart=/usr/bin/node /opt/banana/server/index.js
Restart=always
RestartSec=2
Environment=PORT=3000
Environment=NODE_ENV=production
Environment=BANANA_ADMIN_USER=admin
Environment=BANANA_ADMIN_PASS=CHANGE_ME_STRONG_PASSWORD

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now banana
sudo systemctl status banana --no-pager
```

查看日志：

```bash
sudo journalctl -u banana -f
```

### 6) Nginx 反向代理（80/443 → Node）

创建站点配置：

```bash
sudo nano /etc/nginx/sites-available/banana.conf
```

示例（先用 80，后续再上 HTTPS）：

```nginx
server {
  listen 80;
  server_name your-domain.com;

  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

启用并测试：

```bash
sudo ln -s /etc/nginx/sites-available/banana.conf /etc/nginx/sites-enabled/banana.conf
sudo nginx -t
sudo systemctl reload nginx
```

现在可访问：`http://your-domain.com`

### 7) 配置 HTTPS（Let’s Encrypt）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

完成后，建议在 `banana.service` 里保持 `NODE_ENV=production`（使 Cookie 带 `Secure`）。

### 8) 备份与容量建议

- `data/` 是核心数据目录（用户、图片、收藏、历史），请定期备份
- 普通用户历史记录会自动裁剪到 50 条；收藏不会自动删除
- 若磁盘吃紧：
  - 优先清理 `data/users/*/generated/` 中不需要的文件（收藏会有自己的快照目录）
  - 或在业务层加“自动过期生成图”的策略（可后续继续优化）

## 安全建议（强烈建议）

- 必须使用 HTTPS 部署（否则 Cookie 在公网环境不安全）
- 管理员密码务必设置强密码
- 不要把 `data/` 暴露为静态目录；本项目通过 `/files/...` 且要求登录后访问

## 常见问题

### Q: 我用静态站点托管（S3/OSS）能用吗？

不推荐。此项目的用户系统、图片落盘、收藏/历史限制都依赖 `server/` 后端。

### Q: Admin 如何设置？

- 默认：第一个注册用户自动成为 Admin
- 推荐：在服务环境变量中设置 `BANANA_ADMIN_USER` / `BANANA_ADMIN_PASS`

## 宝塔面板（BT）部署教程（Node 项目）

建议将“项目目录”指向仓库根目录（即包含 `package.json` 的目录），这样宝塔可以直接执行：

- 安装命令：`npm install --omit=dev`
- 启动命令：`npm start`

### 1) 上传/拉取代码

把项目放到例如：`/www/wwwroot/getbanana`

目录里应包含：

- `package.json`
- `server/index.js`
- `banana.html`
- `assets/`

### 2) 创建/配置环境变量

在宝塔 Node 项目里配置环境变量（或在项目目录创建 `server/.env`，注意不要提交到 Git）：

- `PORT=3000`（按你在宝塔里配置的端口/反代端口调整）
- `NODE_ENV=production`（HTTPS 下推荐）
- `BANANA_ADMIN_USER=admin`、`BANANA_ADMIN_PASS=强密码`（推荐）

### 3) 宝塔 Node 项目设置建议

- 项目目录：`/www/wwwroot/getbanana`
- 启动文件/启动命令：优先用 `npm start`（等价于 `node server/index.js`）
- 端口：使用环境变量 `PORT` 控制

### 4) 反向代理（推荐域名访问）

在宝塔里给域名配置反向代理到：

- `http://127.0.0.1:3000`（示例）

并把上传大小限制调大（因为会上传/保存图片），例如 50MB。
