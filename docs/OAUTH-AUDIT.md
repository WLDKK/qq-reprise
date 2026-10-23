# OAuth注册入口核验与更正

源码未预置他人已签发的客户端ID。`dynamic_agent_client` 是 [OpenAI官方OSS注册文档](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 明确规定的首次注册入口；平台随后签发的实际ID才用于交换与复用。[官方概览](https://developers.openai.com/siwc/token-sharing-open-source)说明了用户/工作区及host的绑定边界。

本项目对应路径：

| 源码位置 | 实际行为 |
| --- | --- |
| [ai-auth.mjs](../ai-auth.mjs#L106) 的start | 新账号使用公开动态入口；同一已保存账号复用其签发ID；应用名固定为QQ Recall Assistant。新尝试使用state/nonce/PKCE和本地回调。 |
| 同文件complete | 新注册缺少签发ID或返回动态入口时拒绝；重授权不得替换已选账号的ID。交换沿用原回调及PKCE。 |
| 同文件validateIDToken / accessToken | 验证签名、issuer、audience、有效期、nonce和账号；只有明确授予套餐调用scope才允许推理，刷新继续绑定原签发ID。 |
| [ai-config.mjs](../ai-config.mjs) 与匿名示例 | 默认使用关闭的标准API分支，账号列表与active_profile为空。OAuth是用户主动选择/点击的可选路径。 |
| [ai-storage.mjs](../ai-storage.mjs) 与AIAuth构造器 | 只使用本应用目录内的账号/host/加密记录；不会读取Codex或浏览器账号。 |

这里没有必要生造或复用别人的client_id。真正的账号注册ID必须由官方交互签发，不能用手填字符串代替用户授权、套餐资格或额度。也没有因为这个核验而登录账号、创建注册、生成真实凭据或请求模型。

已有16项授权mock回归另增5项发布边界检查：默认API/空注册、动态入口无自动交换、缺失签发ID拒绝、重授权不替换ID、未知profile不借用其他存储。它们验证代码契约，不能代替真实OAuth接入或账号可用性测试。
