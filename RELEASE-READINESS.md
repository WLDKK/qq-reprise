# 发布验证范围

回笺 · QQ Reprise采用[MIT](LICENSE)，署名WLDKK。公开源码由独立净化目录产生，未携带生产私有配置、日志、聊天缓存或旧Git历史。正式公开地址为 https://github.com/WLDKK/qq-reprise ，发布成功与具体提交以远端结果为准。

已完成：原50项失败分类、恢复上下文与未知投递修复、443项完整离线回归、可复现测试入口、匿名初始化、依赖闭包/语法/敏感模式及本地文档链接检查。功能测试证据与未联调场景见[测试记录](TESTING.md)和[验证清单](CANDIDATE-VERIFICATION.json)。

OAuth的动态注册入口有[官方契约依据](docs/OAUTH-AUDIT.md)，未预置他人签发的客户端ID；默认使用关闭状态的标准API配置。真实OAuth账号资格与服务接入尚未验证。

[来源核查](docs/PROVENANCE-AUDIT.md)检查51个运行文件和四个参考上游的完整公开tree，整文件匹配为0，未发现复制源码证据；此方法不证明全网片段原创性。QQ/NapCat独立安装，遵循各自许可。

文件级校验见[发布清单](RELEASE-MANIFEST.json)。公开源码、供应商可用性和某台机器的生产部署是分别验证的状态；公开发布不代表真实QQ或上游模型已恢复。
