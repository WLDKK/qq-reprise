> 本表的专项mock依据为2026-10-21历史验证；未把该历史专项计入本次443项，也未声称在本目录重新复现全部专项或真实QQ场景。以下是实现/降级边界。

转发撤回重发：支持边界（2026-10-21）

这里的“原生”表示已按 OneBot/NapCat 消息段和专用发送 API 重建，并通过离线 mock 验证；没有向真实群发送验收消息，不保证当前 QQ/NapCat 对所有编码、文件和卡片都接受。只能恢复本助手接收并成功缓存的内容。

| 内容 | 当前行为 | 无法保证恢复时 |
| --- | --- | --- |
| 单层合并转发 | 接收时 `get_forward_msg`，缓存节点作者、正文和可用媒体；撤回时一次 `send_group_forward_msg` / `send_private_forward_msg` 发回原会话 | 明确显示节点获取失败/已失效；不把原 `forward.id` 当可发送正文 |
| 嵌套合并转发 | 降级：按原顺序展开为一张合并转发，保留作者和可用时间，添加层级提示；不声称原嵌套布局完全还原 | 循环、过深、超量处明确提示；避免 NapCat 深层节点静默截断或混合节点丢文字 |
| 文字、QQ表情 | 保留文字和有效表情 ID | 超出文本/片段边界明确提示截断 |
| 转发记录内的 @ | 降级：转为可见 `@成员` / `@全体成员` 文字 | 不在重发档案中重新通知历史提及的成员 |
| 图片、视频、语音、文件 | 对收到的 QQ 媒体 URL / 内嵌 base64 及时缓存原字节；保留文件名，使用对应原生类型发送 | 下载失败、失效、超时或超出预算时，替换为含类型/文件名的缺失说明；不伪称已恢复 |
| 有效 JSON/XML 卡片 | 保留对应消息段 payload；JSON 只解析校验，XML 不解析实体；页面仅显示安全文字摘要 | 无效、过大或危险实体声明转为说明；实际客户端拒绝/无回执不触发备用重发 |
| 仅文件资源 ID、任意本机路径、私网 URL、其他站点 URL | 暂不支持恢复；不读取任意本机文件、不扫描别的会话或私聊、不访问非 QQ 媒体地址 | 文件名/类型和不可恢复原因可见 |
| Markdown、miniapp、onlinefile、flashtransfer 等其他专用段 | 暂不承诺重建 | 明确“未支持的消息类型”，不隐藏成成功恢复 |
| 仅原消息引用、没有正文的 node | 不扫描历史获取任意消息 | 明确节点正文未缓存 |
| 本助手启动前或缓存淘汰后的记录 | 不回放、不恢复；缓存仍仅在 RAM | 明确缺失；重新启动不产生虚构历史缓存 |

资源边界沿用现有单资源 20 MiB / 总媒体 64 MiB / 5 秒准备期限，另有 8 层、200 节点、2000 片段和 256000 字符边界。页面展示缓存独立上限 32 MiB，移除展示媒体时显示说明，不能影响独立的待发送快照。以上不是“所有特殊格式完整恢复”的承诺。

投递与权限：保持原会话、原开关、本人重发开关和按原作者豁免规则。普通消息走原 API，重建转发走专用 API。标题/撤回归属说明包装为节点，避免非法混合根节点。每次仅一次发送；结果不确定继续由原 outbox 保留，连接恢复不自动再次提交，迟到回执可以确认。存在未知投递时禁止部署重载；重启不提供磁盘聊天恢复。

协议依据：

- [OneBot 11 消息段规范](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)
- [NapCat 获取转发节点](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts)
- [NapCat 专用合并转发接口](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/SendForwardMsg.ts)
- [NapCat 发送节点处理](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/msg/SendMsg.ts)
- [NapCat 消息类型定义](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/types/message.ts)

源代码参考为读取时公开主分支；未以真实群消息验证本机 NapCat 的具体版本和全部兼容性。
