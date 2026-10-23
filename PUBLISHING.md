# 发布与维护清单

项目：回笺 · QQ Reprise；仓库：`WLDKK/qq-reprise`；许可证：[MIT](LICENSE)。本地公开候选已完成源码、匿名示例、测试与文档审查，发布使用全新历史。具体发布状态以实际远端提交和外部验证记录为准。

- 根据[SOURCE-MANIFEST](SOURCE-MANIFEST.json)核对运行/测试/隔离工具来源，根据[发布清单](RELEASE-MANIFEST.json)核对实际文件字节。
- 复核[排除项](PUBLISH-EXCLUSIONS.md)，不得把生产配置、DPAPI数据、账号绑定、日志、缓存、备份、原Git历史和内部协调记录加入公开提交。
- 运行适用离线回归与文档链接检查；保留失败证据，明确真实QQ/供应商/OAuth和版本矩阵的未验证边界。
- 公开提交只来自净化目录的明确清单；核对远端可公开读取、README安装地址、LICENSE、主要源码与文件摘要。
- 后续修复分别记录候选、公开源码和实际生产部署状态。未知投递须先核验，不能用重启或自动重投掩盖。

来源核查与证据边界见[第三方说明](THIRD-PARTY-NOTES.md)、[OAuth核验](docs/OAUTH-AUDIT.md)、[测试记录](TESTING.md)。
