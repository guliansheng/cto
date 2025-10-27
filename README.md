# 影视仓接口管理系统

一个基于 Cloudflare Workers + KV 的轻量级影视接口管理后台，帮助你用授权码管理用户、整理影视接口，并输出影视仓兼容 JSON。

---

## ✨ 核心特性

- **授权码登录与多角色权限**：通过环境变量维护管理员授权码，可在面板内增删普通用户访问码。
- **接口管理一站式完成**：为每个授权码维护独立接口清单，支持新增、删除、重命名。
- **接口广场**：所有登录用户都能发布公共接口，管理员可统一审核与清理。
- **访问码管理**：管理员专属页面，支持生成随机授权码、添加备注、移除授权码。
- **专属分享链接**：每位用户获得唯一访问地址，直接输出影视仓所需的 `urls` JSON。

---

## 🧰 功能模块概览

| 模块 | 说明 |
| --- | --- |
| 登录/权限 | 通过授权码登录；管理员授权码由环境变量维护，普通用户授权码支持在线创建/删除 |
| 接口管理 | 用户查询、创建、删除自己的接口；管理员可在面板切换任意用户并管理其接口 |
| 接口广场 | 所有登录用户可发布/删除公共接口（仅限本人或管理员） |
| 访问码管理 | 仅管理员可访问，支持生成随机授权码、添加备注、删除授权码 |
| 接口访问 | 每个授权码对应唯一分享地址，返回 `{"urls": [{"url": "...", "name": "..."}]}` 结构 |

---

## 🧱 技术栈

- **运行时**：Cloudflare Workers
- **框架**：Hono
- **存储**：Cloudflare KV（授权码、接口、会话等信息）
- **前端**：原生 HTML / CSS / JavaScript 单页面
- **开发工具**：TypeScript、Wrangler

---

## ⚙️ 环境要求

- Node.js 18 或以上版本（Wrangler 3.x 需要）
- Cloudflare 账号（拥有 Workers 权限）
- 已安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 3.0+

---

## 🛠️ 本地开发流程

1. 安装依赖

   ```bash
   npm install
   ```

2. 启动本地服务（首次运行前建议完成“部署指南”中的 KV 与 Secret 配置）

   ```bash
   npm run dev
   ```

   默认监听 `http://127.0.0.1:8787`，支持通过 `wrangler dev --local` 在本地模拟环境。

> ⚠️ 本地调试时浏览器运行在 HTTP，系统会根据请求协议自动设置或清除 Cookie，以确保登录态可用。

---

## ☁️ 部署指南

按照以下步骤即可一键部署到 Cloudflare Workers：

### 1. Fork / Clone 项目

- 在 GitHub 上 Fork 本仓库，或直接 Clone 到本地：

  ```bash
  git clone https://github.com/<your-account>/movie-api-management.git
  cd movie-api-management
  ```

### 2. 登录 Wrangler

- 确保安装了 Wrangler 3.x：`npm install -g wrangler`
- 使用 Cloudflare 账号登录：

  ```bash
  wrangler login
  ```

### 3. 创建 Cloudflare KV 命名空间

```bash
# 生产环境 KV
wrangler kv namespace create MOVIE_API_DB

# 开发 / 预览环境（可选）
wrangler kv namespace create MOVIE_API_DB --preview
```

- 记录命令输出的 `id` 与 `preview_id`，稍后需要填入 `wrangler.toml`。

### 4. 配置 `wrangler.toml`

将 `wrangler.toml` 中的占位符替换为实际 KV ID，示例如下：

```toml
name = "movie-api-management"
main = "src/index.ts"
compatibility_date = "2024-10-07"

[vars]
SESSION_TTL_SECONDS = "86400"

[[kv_namespaces]]
binding = "MOVIE_API_DB"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
preview_id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
```

> 若暂未创建预览命名空间，可先删除 `preview_id` 行，后续再补充。

### 5. 设置密钥与环境变量

至少需要配置管理员授权码：

```bash
wrangler secret put ADMIN_CODE
# 根据提示输入管理员登录使用的授权码（如 ADMIN-8888）
```

可选变量：

- `SESSION_TTL_SECONDS`：会话保持时长（秒），默认 86400。

如需在生产环境与预览环境使用不同值，可通过 `wrangler secret put --env <environment>` 进行分别设置。

### 6. （可选）本地连通性验证

完成配置后，可在本地运行：

```bash
npm run dev
```

- 浏览器访问 `http://127.0.0.1:8787`，使用刚配置的 `ADMIN_CODE` 登录。
- 确认 KV 的读写正常（例如新增接口、删除接口等操作）。

### 7. 正式部署到 Cloudflare

执行一次构建与发布：

```bash
npm run deploy
# 或使用 wrangler deploy
```

- 部署完成后，Cloudflare 将返回 Workers 访问域名，例如 `https://movie-api-management.your-subdomain.workers.dev`。
- 使用该地址访问登录页面，输入管理员授权码即可开始管理。

### 8. 绑定自定义域名（可选）

- 在 Cloudflare 控制台进入 `Workers & Pages` → 选择项目 → `Settings` → `Triggers`。
- 点击 **Add custom domain**，填入已在 Cloudflare 托管的域名。
- 按提示完成 DNS 解析后，即可通过自定义域名访问系统。

### 9. 管理配置文件

- 如需修改 KV、环境变量或授权码，可重复执行对应命令。
- 变更配置后重新执行 `wrangler deploy`，确保所有修改生效。

---

## 🗃️ 数据存储结构

- 用户接口：`user:<code>:interfaces` —— 保存用户私有接口数组。
- 接口广场：`public:interfaces` —— 保存所有公共接口。
- 授权码：`access:<code>` —— 保存授权码记录（含备注、创建时间）。
- 分享标识：`share:<shareId>` 映射到授权码；`share-code:<code>` 做反向映射。
- 会话：`session:<token>` —— 保存登录态。

对外公开访问地址：`GET /u/{shareId}`，返回格式示例：

```json
{
  "urls": [
    { "url": "http://47.96.82.41:8/api.json", "name": "名称1" },
    { "url": "http://47.96.82.41:5188/svip/svip.json", "name": "名称2" }
  ]
}
```

---

## ❓ 常见问题

- **管理员授权码在哪里设置？**
  使用 `wrangler secret put ADMIN_CODE` 在 Cloudflare 环境变量中配置，部署后即可直接登录。

- **普通用户如何新增？**
  管理员登录后在「访问码管理」中生成授权码并分发给用户。

- **管理员如何管理普通用户接口？**
  进入「接口管理」标签页，顶部下拉框可切换任意授权码，支持查看 / 新增 / 删除其接口。

- **删除访问码是否清空数据？**
  是。删除访问码会同时清除该用户接口、分享地址及所有有效会话。

---

## 📜 开源协议

本项目仅用于示例交付，可根据业务需求自由扩展。所有第三方依赖请遵循其各自的开源许可。
