# 苦痛之路练习

这是可独立部署的苦痛之路练习站。前端、页面路由和接口统一使用 Next.js 16、React 19 与 TypeScript；排行榜、登录、Replay 上传和导出由 Next Route Handlers 提供，不依赖 Python 服务。

## 运行内容

- Hollow Knight 1.5.12620 和 1.5.78.11833 两个 Unity WebGL 运行包
- 苦痛之路前置房与四个练习房间
- 官方人物控制、动画、场景、碰撞与机关逻辑
- 主键盘数字行 `1` 返回标记点并清空计时器
- 调试面板、计时器、Replay 导出和显影
- 房间排行榜与最多八条 Replay 同屏显影
- 可选的 GitHub、Discord 登录和 Replay 上传

## 本地运行

需要 Node.js 22 或更高版本。

```powershell
cd F:\Project\hk-replay-map\pop
npm ci
npm run build
.\start.ps1 -Port 8011
```

打开 [http://127.0.0.1:8011](http://127.0.0.1:8011)。默认只加载 1.5.12620，另一个版本在切换后才会下载。

开发时使用：

```powershell
npm run dev -- --hostname 127.0.0.1 --port 8011
```

## 配置

将 `.env.example` 复制为 `.env`，按部署环境设置：

```text
POP_PUBLIC_URL=https://你的站点域名
POP_R2_PUBLIC_URL=https://你的资源域名
POP_HERO_MANIFEST_URL=https://你的资源域名/generated/hero/knight_manifest.20260805T033206.json
POP_DATABASE_PATH=data/replays.sqlite3
SESSION_SECRET=足够长的随机值
SESSION_COOKIE_SECURE=true
```

OAuth 回调地址：

```text
https://你的站点域名/auth/github/callback
https://你的站点域名/auth/discord/callback
```

没有配置 OAuth 时，练习、计时、调试和 Replay 导出仍可使用，登录按钮保持禁用。

## R2 与服务器流量

六个大型 Unity 文件、27 张人物图和人物清单由 Cloudflare R2 直接响应。浏览器拿到 `/api/practice/builds` 与 `/api/hero-animation` 的地址后，会直接向 R2 下载资源，文件内容不经过自托管服务器，因此不会计入服务器的出站流量。

当前 R2 对象约占 `241,088,336` 字节，也就是约 `230 MiB`：

- 六个 Unity 大文件：`217,964,371` 字节
- 人物图与清单：`23,123,965` 字节

R2 根地址显示对象不存在是正常现象，公开地址必须包含完整对象路径。

## 为什么不是 GitHub Pages

本站包含 SQLite 写入、OAuth 回调、签名会话、Replay 上传和动态接口。GitHub Pages 只能托管静态文件，不能运行这些服务端功能，因此完整站点应部署到支持 Node.js 或容器的平台。R2 只承担大型静态资源分发。

## Docker

```powershell
docker build -t openpop .
docker run --rm -p 8011:8011 --env-file .env -v ${PWD}/data:/app/data openpop
```

也可以使用：

```powershell
docker compose up --build
```

镜像使用 Node.js 22 和 Next.js 独立生产输出，不包含 R2 上的大型 Unity 文件与人物 PNG。`data` 目录必须持久化。

## 检查

```powershell
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

服务启动后可运行：

```powershell
npm run verify:site:12620
npm run verify:site:1578
npm run verify:package:12620
npm run verify:package:1578
```

健康检查地址为 `/health`。两个版本的加载器和清单齐全时，返回值中的 `ok` 为 `true`。

## 目录

```text
src/app/                 页面与接口路由
src/components/          React 客户端组件
src/lib/                 Replay、数据库、OAuth 与配置
public/static/           Unity 浏览器桥和页面样式
runtime/unity-webgl/     Unity 加载器、清单和小型运行文件
runtime/hero/            人物资源清单，PNG 仅保留在本地与 R2
data/                    SQLite 与会话密钥
tools/                   浏览器和运行包检查脚本
```
