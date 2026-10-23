# 依赖、再分发与来源核验

核验日期：2026-10-23。49个运行mjs仅引用Node内置模块和本地源码，闭包完整；没有外部npm import、node_modules、vendor或附带第三方程序。测试工具同样只用Node内置模块。

运行环境：Windows、Node.js 22.4+、Windows PowerShell/.NET DPAPI；media-frame.ps1使用Windows PresentationCore/WindowsBase。此次实际测试Node.js 24.14，未完成其他版本矩阵。[Node WebSocket文档](https://nodejs.org/api/globals.html#class-websocket)

QQ/NapCat由使用者独立安装。候选未复制其源码或二进制。NapCat当前 [LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE) 为Limited Redistribution License，包含非商业及修改版本公开发布限制；本项目未来选择的许可不覆盖它，也不能据此代替原作者授权。

原工程README第147行及AI-DESIGN.md第51—57行说明参考分层/协议并声明未复制源码。本次进一步核对51个运行文件、imports/vendor/版权标记，并与LangBot、AstrBot、NoneBot OneBot适配器、NapCat四个完整公开tree进行本地整文件指纹比较：0匹配，未发现第三方复制代码证据。具体来源路径、tree指纹与方法边界见[来源审计](docs/PROVENANCE-AUDIT.md)。剩余是作者的权属/授权声明，而非已查明侵权或待补的第三方源码许可。

OAuth入口也已核实：dynamic_agent_client由[OpenAI官方OSS注册文档](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)公开规定，代码保存/复用的是用户授权后签发的独立ID，不内置他人注册ID。默认API关闭配置不会自动登录；OAuth属于显式选择的可选适配，真实接入和账号可用性未测试。详见[OAuth核验](docs/OAUTH-AUDIT.md)。
