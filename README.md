# 苦痛之路练习

这是从 `hk-replay-map` 中拆出的独立部署项目。运行时只读取本目录中的文件，不导入父目录的 Python 模块，也不读取父目录的 `runtime`。

## 内容

- Hollow Knight 1.5.12620 Unity WebGL 运行包
- Hollow Knight 1.5.78.11833 Unity WebGL 运行包
- 只打包苦痛之路前置房 `White_Palace_06` 和四个练习房间
- 使用不含完整 `Menu_Title` 的最小启动场景
- 官方人物控制、动画、场景、碰撞与机关逻辑
- 主键盘数字行 `1` 返回前置房椅子并清空计时器
- Debug 面板、计时器、Replay 导出和显影
- Replay 房间榜单
- 可选的 GitHub、Discord 登录和 Replay 上传

## 本地运行

```powershell
cd F:\Project\hk-replay-map\pop
python -m pip install -r requirements.txt
.\start.ps1 -Port 8011
```

打开 [http://127.0.0.1:8011](http://127.0.0.1:8011)。

页面启动时只创建一个 Unity 实例并加载默认的 1.5.12620。另一个版本只有在用户切换版本后才开始下载和初始化。

也可以直接使用 Uvicorn：

```powershell
python -m uvicorn server:app --host 0.0.0.0 --port 8011
```

## 目录

```text
pop/
  pop_app/                 独立 Replay、数据库和 OAuth 模块
  templates/               练习页与 Unity 运行器页面
  static/                  页面、计时器、Debug 和榜单资源
  runtime/hero/            Replay 显影使用的人物图集
  runtime/unity-webgl/     Unity WebGL 加载器、清单和小型运行资源
  data/                    运行时生成的 Replay 数据库和会话数据
  tests/                   后端接口回归
  tools/                   浏览器与运行包验证
  server.py                独立 FastAPI 入口
```

## 测试

后端接口：

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
```

浏览器测试需要 Playwright：

```powershell
npm install
npx playwright install chromium
npm run verify:site:12620
npm run verify:site:1578
npm run verify:package:12620
npm run verify:package:1578
```

站点测试确认独立服务能加载到前置房坐椅状态。运行包测试还会确认：

- 坐起后计时开始
- 小键盘 `1` 不触发返回
- 主键盘数字行 `1` 返回椅子
- 游戏时间和现实时间同时清零

## Docker

```powershell
docker build -t path-of-pain-practice .
docker run --rm -p 8011:8011 --env-file .env path-of-pain-practice
```

也可以使用：

```powershell
docker compose up --build
```

`data` 目录是可写数据目录。生产环境应将它挂载为持久卷，并设置 `SESSION_SECRET`。
Docker 镜像不会复制 Unity 的三个大型文件，因此 Docker 部署还必须设置 `POP_R2_PUBLIC_URL`；直接使用 `start.ps1` 的本地部署仍会读取本地运行包。

## Brotli、缓存和 R2

两个 Unity 包的 `.data`、`.wasm` 和 `.framework.js` 均使用 Brotli。独立服务会为 `.br` 文件设置正确的 `Content-Encoding`，并对静态资源设置：

```text
Cache-Control: public, max-age=31536000, immutable
```

源码仓库不包含 Unity 运行包中的 `.data`、`.wasm` 和 `.framework.js` 大文件。生产环境需要从 Cloudflare R2 提供这些文件；保留了完整运行包的本地目录仍可由 `start.ps1` 直接读取。准备好 R2 的 S3 访问密钥和公开域名后执行：

```powershell
$env:AWS_ACCESS_KEY_ID='你的 R2 Access Key ID'
$env:AWS_SECRET_ACCESS_KEY='你的 R2 Secret Access Key'
./tools/publish_r2.ps1 `
  -AccountId '你的 Cloudflare Account ID' `
  -Bucket '你的存储桶名称' `
  -PublicUrl 'https://assets.example.com'
```

脚本只上传 `.data`、`.wasm` 和 `.framework.js`，逐个核验公开地址、Brotli 响应头和一年缓存头。部署服务时设置：

```text
POP_R2_PUBLIC_URL=https://pub-1b49211ea9574b738e1f01da86abe74d.r2.dev
```

当前六个大型文件存放在 `openpop-assets` 存储桶。版本清单会让加载器和小型 `StreamingAssets` 继续走当前站点，仅让三个大型文件走 R2。R2 公开域名允许练习站点跨域发起 `GET`、`HEAD` 请求。

## 登录配置

复制 `.env.example` 中的变量到部署环境。回调地址分别为：

```text
https://你的域名/auth/github/callback
https://你的域名/auth/discord/callback
```

没有配置 OAuth 时，练习、Debug、计时和本地 Replay 导出仍可使用；登录按钮会保持禁用。

## 部署检查

服务启动后访问 `/health`。只有两个 Unity 版本的加载器、数据、框架和 WebAssembly 文件全部存在时，返回值中的 `ok` 才会是 `true`。
