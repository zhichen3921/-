# 贡献指南

感谢你对 Application Desk 的兴趣。

## 提交前检查

- 不要提交真实姓名、简历、岗位状态、沟通话术、Cookie、令牌或浏览器用户目录。
- 新功能请同时补充测试和使用说明。
- 本地服务必须继续只绑定 `127.0.0.1`，不要扩大跨域或扩展权限范围。
- 运行与改动相关的测试，至少执行 `pnpm run test:unit`。

## 提交方式

1. Fork 仓库并创建功能分支。
2. 使用 Conventional Commits，例如 `feat(extension): improve current-job extraction`。
3. 提交 Pull Request，说明改动、测试方式和已知限制。
4. 不要在 Pull Request 中附加个人数据或真实招聘页面截图。
