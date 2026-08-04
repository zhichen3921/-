# 投递台 · Application Desk

一个本地优先的求职岗位筛选与投递队列工具，适合把公开岗位和你主动核验的 BOSS 当前岗位集中管理。

> 当前版本是 MVP。它不会自动登录、批量爬取、投递简历或发送消息；最终的岗位核验、沟通和投递始终由用户确认。

## 功能

- 通过地点、届别、方向、技能和实习安排对岗位进行匹配评分。
- 管理岗位队列、待复核岗位、沟通状态和个性化话术。
- 从公开招聘页面导入经过核验的岗位批次。
- 通过 Edge 扩展，在你点击后读取当前可见的 BOSS 岗位详情。
- 所有投递数据默认保存在本机，服务只监听 `127.0.0.1`。
- 支持 JSON 导入/导出，便于手动备份。

## 安全边界

- BOSS 扩展只在用户主动点击后读取当前活动标签页，不自动翻页或扫描列表。
- 扩展不读取 Cookie、聊天记录、验证码或登录密码，也不会自动发送消息或投递简历。
- 本地服务不对局域网开放；不要把它部署到公网，也不要提交个人岗位数据、浏览器目录或配对令牌。
- 使用本项目时请遵守目标网站的服务条款、robots 规则和适用法律。

## 环境要求

- Node.js 20 或更高版本
- npm 或 pnpm
- 如需使用 BOSS 扩展：Microsoft Edge

## 快速开始

```powershell
pnpm install
pnpm start
```

然后打开 <http://127.0.0.1:43127/>。

没有 pnpm 时也可以使用：

```powershell
npm install
npm start
```

Windows 用户也可以双击根目录的 `打开投递台.cmd`。该启动器会启动本地服务并打开独立的 Edge 用户目录。

## 安装浏览器扩展

1. 启动本地服务并打开投递台。
2. 在 Edge 打开 `edge://extensions/`，开启开发人员模式。
3. 选择“加载解压缩的扩展”，选择仓库中的 `extension` 文件夹。
4. 在投递台“更新中心”生成扩展配对令牌，再在扩展设置中粘贴并保存。
5. 打开一个 BOSS 岗位详情页，点击扩展，核对预览后手动加入队列。

完整说明见 [docs/安装BOSS采集扩展.md](docs/安装BOSS采集扩展.md)。

## 配置个人画像

仓库内的 `shared/resume-profile.mjs` 和 `client/profile.js` 是不含个人信息的示例配置。使用前请按你的实际情况修改姓名、学历、毕业年份、技能和项目证据；两处配置应保持一致。

当前工作区中的个人配置使用了被 `.gitignore` 忽略的本地覆盖文件，不会进入公开仓库。新克隆的用户只会得到公开模板。

## 数据位置

运行后生成的数据位于 `data/`，包括岗位状态、沟通话术、更新批次和日志；这些内容已被 `.gitignore` 排除。请使用应用内的“导出数据”功能备份，不要把真实求职数据提交到公共仓库。

## 测试

```powershell
pnpm run test:unit
pnpm run test:extension
pnpm run test:app
pnpm run test:e2e
```

也可以运行完整测试：

```powershell
pnpm run test:all
```

首次运行浏览器测试时，可能需要先安装 Playwright Chromium：

```powershell
pnpm exec playwright install chromium
```

## 已知限制

- BOSS 页面结构变化可能导致当前岗位提取需要更新。
- 公开岗位更新需要用户显式点击执行，当前版本不创建系统定时任务。
- Windows 启动器依赖 Node.js 和 Microsoft Edge；其他系统可直接运行 `npm start`。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并避免提交个人数据、浏览器配置、日志和令牌。

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖和招聘网站内容仍分别受其各自许可证、版权和服务条款约束。
