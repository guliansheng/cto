# 影视仓接口管理系统

基于 Cloudflare Workers 的轻量级影视接口管理后台，满足以下需求：

- 🔐 授权码登录与权限控制，管理员可统一管理普通用户
- 🌐 接口管理、接口广场、访问码管理三大模块
- ☁️ 一键部署到 Cloudflare，数据存储使用 Cloudflare KV 免费套餐
- 🔗 为每位用户生成独立访问地址，输出影视仓兼容 JSON

## 功能概览

| 模块 | 说明 |
| --- | --- |
| 登录/权限 | 通过授权码登录；管理员授权码由环境变量维护，普通用户授权码支持在线创建/删除 |
| 接口管理 | 用户查询、创建、删除自己的接口；管理员可在面板切换任意用户并管理其接口 |
| 接口广场 | 所有登录用户可发布/删除（仅限本人或管理员）公共接口 |
| 访问码管理 | 仅管理员可访问，支持生成随机授权码、添加备注、删除授权码 |
| 接口访问 | 每个授权码对应唯一分享地址，返回 `{"urls": [{"url": "...", "name": "..."}]}` 结构 |

## 技术栈

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) 运行时
- [Hono](https://hono.dev/) 轻量服务框架
- Cloudflare KV 作为存储（授权码、接口数据、会话信息等）
- 原生 HTML/CSS/JavaScript 单页面界面

## 本地开发

1. 安装依赖

   ```bash
   npm install
   ```

2. 启动本地服务（需先准备 KV 绑定，见下文配置）

   ```bash
   npm run dev
   ```

   默认监听 `http://127.0.0.1:8787`。

> ⚠️ 本地调试时浏览器运行在 HTTP，系统为保证开发体验，会根据请求协议自动设置/清除 Cookie。

## Cloudflare 配置与部署

### 1. 创建 KV Namespace

```bash
# 生产环境
wrangler kv namespace create MOVIE_API_DB

# 开发环境（可选）
wrangler kv namespace create MOVIE_API_DB --preview
```

记录命令输出的 `id` 与 `preview_id`，填入 `wrangler.toml` 中 `REPLACE_WITH_YOUR_*` 位置。

### 2. 配置环境变量

至少需要设置管理员登录用的授权码：

```bash
wrangler secret put ADMIN_CODE
# 根据提示输入管理员授权码，例如 ADMIN-8888
```

其它可选变量：

- `SESSION_TTL_SECONDS`：会话保持时长（秒），默认为 86400（24 小时）。

### 3. 一键部署

确认 `wrangler.toml` 中已填写 KV ID 后执行：

```bash
npm run deploy
```

部署完成后，Cloudflare 将返回绑定域名。

## 数据结构与接口

- 用户接口：`user:<code>:interfaces` 保存用户私有接口数组
- 接口广场：`public:interfaces` 保存所有公共接口
- 授权码：`access:<code>` 保存授权码记录（含备注、创建时间）
- 分享标识：`share:<shareId>` 映射到授权码；`share-code:<code>` 反向映射
- 会话：`session:<token>` 保存登录态

对外公开访问地址：`GET /u/{shareId}`，返回格式示例：

```json
{
  "urls": [
    { "url": "http://47.96.82.41:8/api.json", "name": "名称1" },
    { "url": "http://47.96.82.41:5188/svip/svip.json", "name": "名称2" }
  ]
}
```

## 常见问题

- **管理员授权码在哪里设置？**
  在 Cloudflare 环境变量（`wrangler secret put ADMIN_CODE`）中配置，部署后可从登录页直接使用。

- **普通用户如何新增？**
  管理员登录后在“访问码管理”中生成授权码并分发给用户。

- **管理员如何管理普通用户接口？**
  进入“接口管理”标签页，顶端下拉框可切换任意授权码，支持查看/新增/删除其接口。

- **删除访问码是否清空数据？**
  是。删除访问码会同时清除该用户接口、分享地址及所有有效会话。

## 开源协议

本项目仅用于示例交付，可根据业务需求自由扩展。所有第三方依赖请遵循其各自的开源许可。