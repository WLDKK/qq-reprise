# 第三方来源核验

结论：在检查范围内未发现第三方复制代码证据。剩余需要的是作者对自身代码权属/授权与署名的确认，不是已发现侵权，也没有已查明却未补的第三方许可。

## 本地证据与核验范围

原工程README第147行声明独立编写、只参考框架设计；AI-DESIGN.md第51—57行列出官方协议和设计参考。原文含私有运行信息，未整份复制进候选。已检查51个运行文件、导入闭包、vendor/二进制和版权/复制标记；无外部npm导入、无vendor/第三方程序、无框架或复制声明标记。

对明确提及的四个上游仓库，下载完整公开tree元数据，在本机比较51个运行文件的Git blob指纹及统一LF后的指纹；未向上游发送候选源码或指纹。此方法证明范围是整文件匹配，不是全网所有片段的相似性鉴定。

| 上游 | 请求分支 | 固定tree SHA | 公开blob数量 | 整文件匹配 |
| --- | --- | --- | ---: | ---: |
| `langbot-app/LangBot` | `master` | `5ec41f15a16ecdf4354e54456243235b4183c27c` | 2339 | 0 |
| `AstrBotDevs/AstrBot` | `master` | `0cd42bd4dd216d8810da4e3f5fb2e381d3c6817e` | 1848 | 0 |
| `nonebot/adapter-onebot` | `master` | `2f5930d4f6c7fb3a82cf3201639e8f0b0a6c124e` | 83 | 0 |
| `NapNeko/NapCatQQ` | `main` | `3420f0b76d7dc0ac92cde1663f21ea27f61e13bb` | 1051 | 0 |

## 具体引用来源与本地对应

| 参考来源 | 对应本地路径 | 所见证据 / 边界 |
| --- | --- | --- |
| [LangBot架构](https://github.com/langbot-app/LangBot/blob/master/ARCHITECTURE.md)及pipeline/controller设计 | ai-chat.mjs、send-queue.mjs、retained-outbox.mjs | 原设计文档说明借鉴分层、并发和finally释放思想；本地是Node模块，未导入LangBot，未发现整文件指纹匹配。根许可Apache-2.0不自动覆盖其全部插件组件。 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) provider/event分层 | ai-providers.mjs、ai-chat.mjs | 原文档说明只参考分层，不引入源码；未见依赖、vendor或整文件匹配。 |
| [NoneBot OneBot事件](https://github.com/nonebot/adapter-onebot/blob/master/nonebot/adapters/onebot/v11/event.py) | engine.mjs、input-mentions.mjs | 对接群/用户/账号范围，使用OneBot字段；没有导入Python适配器。实际参考适配器的[许可是MIT](https://github.com/nonebot/adapter-onebot/blob/master/LICENSE)，不能只拿NoneBot2主项目许可代替核对。 |
| [OneBot消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)与[NapCat动作](https://github.com/NapNeko/NapCatQQ/tree/main/packages/napcat-onebot/action) | engine.mjs、recall-rich-message.mjs | 使用协议字段和动作名，不附带NapCat源码/程序；无整文件匹配。 |
| [OpenAI官方OSS注册契约](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | ai-auth.mjs、ai-storage.mjs、oauth-diagnostic.mjs | 公共入口、scope及协议字段有官方依据；具体实现和可选边界详见[OAuth核验](OAUTH-AUDIT.md)。 |
| Node与Windows系统API | ui.html、media-frame.ps1及其余本地模块 | 未见内嵌前端vendor、下载器或第三方二进制；PowerShell辅助文件调用系统.NET API。 |

完整方法、固定上游指纹及具体路径见[机器可读来源审计](../PROVENANCE-AUDIT.json)。

许可处置：未发现需要从候选移除或补NOTICE的已复制第三方文件；没有据此宣称全网无片段改写。维护者确认版权与选择本项目许可证后，按确认的最终内容发布。QQ/NapCat仍独立安装，不受本项目许可证再授权。
