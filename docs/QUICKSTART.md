# 第一次运行回响 QQ 助手

目标是先打开本机管理页并确认连接，再逐项选择功能。默认不启用 AI、自动重发或官方群打卡；安装过程不要求真实群消息或模型请求。

## 需要什么版本

| 组件 | 要求或已验证范围 | 这不能证明什么 |
| --- | --- | --- |
| Windows | 本项目使用 Windows PowerShell / .NET 和当前用户 DPAPI；本次离线验证平台为 win32 / x64 | 未验证 macOS、Linux 或全部 Windows 构建 |
| Node.js | 旧行为最低前置边界为 **22.4.0**；新 AI 网络模式需 **24.14+**；本次完整回归使用 **24.14.0** | 版本号达标不等于所有组合已联调 |
| QQ + NapCat | 需要可用的 OneBot 11 正向 WebSocket；官方打卡另需 PacketBackend | QQ 已登录不等于 PacketBackend 可用 |
| 历史兼容样本 | NapCat Shell **4.18.41** 与 QQ 热更新运行构建 **9.9.36-53644-x64** 做过本机兼容检查 | 不保证其他版本或后续 QQ 热更新；这不是要求所有用户升级到该组合 |
| API / OAuth | AI 由使用者提供受支持的接入、凭据和模型；不启用 AI 时无需配置 | 本项目不附赠额度，也不保证账号资格 |

最低 Node 边界来自所用内置功能：全局 WebSocket 在 [Node 22.4.0 起不再标记为实验性](https://nodejs.org/api/globals.html#class-websocket)。源码只用 Node 内置模块和本地文件，**无需 `npm install`**。QQ 和 NapCat 不随源码分发；版本及安装来源参考 [NapCat 官方文档](https://doc.napneko.icu/) 和 [4.18.41 发布页](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41)。不要为了尝试本项目而替换已经正常运行的 QQ/NapCat 组合。

## 获取源码与离线自检

安装 Node 和 Git 后，在一个准备存放新目录的位置打开 PowerShell：

```powershell
git clone https://github.com/WLDKK/qq-reprise.git
Set-Location qq-reprise
node scripts/check-environment.mjs
if ($LASTEXITCODE -ne 0) { throw '请先解决环境自检中未满足的前置条件。' }
```

自检只读取 Node/平台功能信息并检查已知 PowerShell 可执行文件是否可读；不运行 PowerShell、不连接 QQ/NapCat/模型，不读取运行配置或凭据，不修改设置。`通过` 不代表 QQ、PacketBackend、API 或账号范围已验证。其他 Node 版本达到前置条件时允许继续，但会明确提示未进入本次实测矩阵。

若使用源码 ZIP，先解压到新目录并进入实际包含 `qq-recall.mjs` 和 `examples` 的根目录，再运行自检，跳过上面的 clone 两行。源码 ZIP 不是安装器，不要覆盖解压到正在运行的私有目录。自检也不尝试解密已有DPAPI凭据。

如果 `node` 命令不存在，先安装 [Node.js](https://nodejs.org/en/download)，重新打开 PowerShell；自检不会自动安装任何软件。反馈环境问题可使用 `node scripts/check-environment.mjs --json`，其输出不包含用户名、机器名、绝对路径、QQ/群号或密钥。

## 仅全新目录：建立匿名配置

```powershell
if ((Test-Path -LiteralPath 'config.json') -or (Test-Path -LiteralPath 'ai-settings.json')) {
    throw '已有运行配置，请保留原文件并按升级说明操作，不要覆盖。'
}
Copy-Item -LiteralPath 'examples\config.example.json' -Destination 'config.json'
Copy-Item -LiteralPath 'examples\ai-settings.example.json' -Destination 'ai-settings.json'
```

只有全新目录需要这一步。已有配置升级不要重复复制示例。官方群打卡配置可以在页面单独建立；其 [匿名示例](../examples/group-sign-settings.example.json) 默认关闭且没有群。

## 连接自己的 NapCat

1. 在独立安装的 QQ/NapCat 中完成本人登录，启用 **OneBot 11 正向 WebSocket 服务端**，使用本机地址。反向 WebSocket 不是这里的接入方式。
2. 助手会查找常见 NapCat 目录中的已启用配置。如安装在其他位置，可仅在当前 PowerShell 会话设置根目录：

   ```powershell
   $env:NAPCAT_DIR = 'C:\NapCat.Shell'
   ```

   将这个示例改为自己的 NapCat 根目录。Token 保留在本机配置中，不放进命令行、截图或公开反馈。
3. 启动助手：

   ```powershell
   node qq-recall.mjs --no-browser
   ```

4. 打开终端实际输出的管理页地址。服务仅绑定 `127.0.0.1`，端口每次可能不同；不要沿用旧端口。页面可打开还需要核对 QQ 在线、登录账号与自己的绑定一致。

同一账号/群不要同时运行多份助手目录。不要把开源候选或备份目录另启动成生产实例。遇到连接问题先看 [排查指南](TROUBLESHOOTING.md)，不要先清空配置、凭据或去重账本。

## 按需只开一项

| 想先试什么 | 需要自己明确配置 | 初次核对 |
| --- | --- | --- |
| 撤回重发 | 群/好友范围、监控和自动重发开关 | 只有已收到并成功缓存的内容才有可能重建；真实测试须选择允许测试的会话 |
| AI | 接收方、协议、模型、凭据、QQ 绑定和允许范围 | 接口测试会产生真实上游请求；文字成功不代表图像能力成功，旧记录不证明新配置可用 |
| 官方群打卡 | 独立总/分群开关、时间、时区、补打和未知策略 | 先只读检测能力，保存后核下次时间；手动打卡是真实动作，不是演示按钮 |

时间、名单、输出/超时、上下文和打卡策略均可在相应设置中调整。各字段的0值、继承与限制不同，详见 [配置指南](CONFIGURATION.md)。不要通过清空记录来强行重打未知投递。

## 在一个获准会话中完成最小试用

先只试撤回重发，AI和官方群打卡继续关闭。选择一个参与者已同意测试的会话，确认页面的监视范围只包含这个会话，再明确开启监视和自动重发。

请一位愿意配合的测试成员发送固定合成文字 `回响 QQ 助手示例消息`。等本机会话缓存有相应记录后，由该成员撤回一次，再分别核对助手的处理记录与原会话中的重建结果。这里使用其他获准测试成员的消息，避免把“自身撤回重发”和自身消息上报设置混入第一次验证。

若缓存未收到、资源缺失、投递失败或结果未知，先停在该状态并按排查指南核对，不重复发送或清空记录来制造成功。完成后按需要关闭这项测试开关，不影响仍关闭的AI/打卡；已有生产实例不应照抄这一段去替换原监视名单。

遇到问题可使用[仓库Issue入口](https://github.com/WLDKK/qq-reprise/issues/new)，附[最小脱敏复现格式](TROUBLESHOOTING.md#提交一个可处理的问题)。不要贴账号/群号、密钥、聊天正文或完整运行目录。

## 退出与升级

在运行终端中用 `Ctrl+C` 退出。先核对生成、待发送与结果未知的任务；RAM 聊天/缓存不等于持久备份。升级时备份并保留原有私有配置、绑定、用量和账本，只更新经核对的源码。已有运行目录与公开源码包应分开，不能把本机配置打包上传。

源码发布、某个供应商可用、某台电脑部署和真实群业务成功是不同状态。测试覆盖与缺口见 [TESTING](../TESTING.md)；发布前检查见 [PUBLISHING](../PUBLISHING.md)。

## 单独配置 AI 网络

浏览器可访问供应商不等于助手进程使用了相同代理。不要把代理地址填进 API Base URL。在本机页面选择独立的 AI 网络方式，先用合成草稿测试，再按需单独保存；默认不会更换原路由。匿名示例为 [ai-network.example.json](../examples/ai-network.example.json)，保持旧行为且没有代理地址。详细步骤见 [AI 网络与测试](AI-NETWORK-AND-TEST.md)。
