# 原50项失败裁定
原始快照：17文件/400项，350通过、50失败。原报告保留在维护者本地审计目录，未用新结果覆盖。表中名称均来自合成测试，不是用户聊天记录。
50个失败用例中，2个指向同一未知投递记录丢失缺陷，45个属于旧预期，3个是有限TTL夹具问题。原400项计数未减少；旧输入/断言保留在基线，数据与预期更新逐项披露，没有把失败改为skip。另有已独立复现并修复的恢复清空记忆缺陷，新增32项回归。
可检查[完整分类数据](../TRIAGE-50.json)、[测试调整差异](TEST-CONTRACT-CHANGES.diff)、[未知投递修补](UNKNOWN-DELIVERY-FIX.diff)和[恢复修补](BACKEND-RECOVERY-FIX.diff)。更新预期的依据是现有公开配置/功能契约，不是只把实际值抄成期望值。
| ID | 原测试文件 / 名称 | 分类 | 依据与处理 |
| ---: | --- | --- | --- |
| 1 | `ai-chat.test.mjs` — history is isolated by user and peer and never includes an undelivered response | 旧预期 | 群历史按已验证任务链和话题相关性选择。原用例用不相关的 prompt-4 却期望自动带回 prompt-1；改为显式回复自己的原任务，仍验证跨作者/跨群隔离。 |
| 2 | `ai-chat.test.mjs` — unknown QQ submission is held, not retried or committed as delivered context | 真实缺陷 | 未知投递进入 uncertain 后被取消并移出列表。候选保留回执记录，释放生成槽；后续新任务可继续，旧未知任务不重发，迟到回执不倒序插入历史。 |
| 3 | `ai-chat.test.mjs` — same-context generation is serialized; other-user contexts fit global concurrency | 旧预期 | 同群不同作者仍属于同一会话，必须保序；跨会话才能并行。夹具改为两个已授权群，仍验证全局并发和同会话顺序。 |
| 4 | `ai-chat.test.mjs` — queue TTL, session TTL and session count bounds discard old work | 夹具问题 | 默认会话保留时间为0（不按时间删除）；队列期限含入队时确定的请求/冷却余量。过期用例需显式配置有限TTL与有限请求预算。 |
| 5 | `ai-chat.test.mjs` — private pause never calls provider or sends pause message: 我生病了 | 旧预期 | 话题词不再被当作秘密值。用合成的 password/api_key/token 赋值替代健康/工资/身份证话题词，继续严格验证零上游调用、暂停、容量及取消行为。 |
| 6 | `ai-chat.test.mjs` — private pause never calls provider or sends pause message: 银行卡和工资资料 | 旧预期 | 话题词不再被当作秘密值。用合成的 password/api_key/token 赋值替代健康/工资/身份证话题词，继续严格验证零上游调用、暂停、容量及取消行为。 |
| 7 | `ai-chat.test.mjs` — private pause never calls provider or sends pause message: 我的身份证 | 旧预期 | 话题词不再被当作秘密值。用合成的 password/api_key/token 赋值替代健康/工资/身份证话题词，继续严格验证零上游调用、暂停、容量及取消行为。 |
| 8 | `ai-chat.test.mjs` — one sensitive message holds the private conversation and later benign text stays local | 旧预期 | 话题词不再被当作秘密值。用合成的 password/api_key/token 赋值替代健康/工资/身份证话题词，继续严格验证零上游调用、暂停、容量及取消行为。 |
| 9 | `ai-chat.test.mjs` — private payload never uploads custom instructions | 旧预期 | 普通私聊明确使用用户保存的角色与指令。旧测试禁止所有自定义指令，与现有配置契约冲突；新断言验证已选角色生效且设置不变。 |
| 10 | `ai-chat.test.mjs` — sensitive private input cancels an earlier same-conversation generation even if abort ignored | 旧预期 | 话题词不再被当作秘密值。用合成的 password/api_key/token 赋值替代健康/工资/身份证话题词，继续严格验证零上游调用、暂停、容量及取消行为。 |
| 11 | `ai-chat.test.mjs` — unknown private QQ send is not retried or committed as delivered history | 真实缺陷 | 未知投递进入 uncertain 后被取消并移出列表。候选保留回执记录，释放生成槽；后续新任务可继续，旧未知任务不重发，迟到回执不倒序插入历史。 |
| 12 | `ai-chat.test.mjs` — private pause capacity fails closed and does not evict another held peer into service | 旧预期 | 话题词不再被当作秘密值。用合成的 password/api_key/token 赋值替代健康/工资/身份证话题词，继续严格验证零上游调用、暂停、容量及取消行为。 |
| 13 | `ai-chat.test.mjs` — sensitive private input cancels an already generated reply waiting in QQ queue | 旧预期 | 话题词不再被当作秘密值。用合成的 password/api_key/token 赋值替代健康/工资/身份证话题词，继续严格验证零上游调用、暂停、容量及取消行为。 |
| 14 | `ai-providers.test.mjs` — config validation is bounded, default-off and rejects credential URLs or unknown fields | 旧预期 | 可配置整数范围和去重后的QQ列表已取代旧的3并发/20轮/100项硬上限。保留类型、整数、正下界、非法账号、未知字段和含凭据URL的拒绝测试。 |
| 15 | `ai-providers.test.mjs` — an upstream key-shaped error code is hidden | 旧预期 | HTTP401 映射为脱敏的 authorization_required，已不再是泛化 upstream_error。仍严格断言不泄露上游密钥形状字符串。 |
| 16 | `chat-context.test.mjs` — consented nearby ordinary context stays within group and excludes blacklisted and recognized sensitive text | 旧预期 | 群背景需同群、已获导出许可且与当前话题相关。无关背景应排除；夹具改为话题相关的合成凭据，确保敏感过滤不依赖话题无关而碰巧通过。 |
| 17 | `chat-context.test.mjs` — API group blacklist migration supplies an empty default and validates entries without reinterpreting legacy users | 旧预期 | 可配置整数范围和去重后的QQ列表已取代旧的3并发/20轮/100项硬上限。保留类型、整数、正下界、非法账号、未知字段和含凭据URL的拒绝测试。 |
| 18 | `chat-context.test.mjs` — a real bot mention still works alongside other mentions; private mentions do not change scope | 旧预期 | 群里同时@机器人和他人时，需要有序且匿名化的提及关系JSON；私聊不导出这些群元数据。旧断言把群prompt视为纯正文。 |
| 19 | `chat-context.test.mjs` — persona is editable text with stable permissions and no external profile actions | 旧预期 | 可配置整数范围和去重后的QQ列表已取代旧的3并发/20轮/100项硬上限。保留类型、整数、正下界、非法账号、未知字段和含凭据URL的拒绝测试。 |
| 20 | `features.test.mjs` — combined enable fails closed when AI credentials are missing and never sends a false success confirmation | 旧预期 | 有权控制者开机失败会收到一次真实失败说明；它不同于模型失败回复。验证不发送虚假成功、不解除暂停，普通成员不会多收到控制确认。 |
| 21 | `features.test.mjs` — combined enable does not clear an AI safety block or let ordinary users control either feature | 旧预期 | 有权控制者开机失败会收到一次真实失败说明；它不同于模型失败回复。验证不发送虚假成功、不解除暂停，普通成员不会多收到控制确认。 |
| 22 | `features.test.mjs` — confirmation echoes arriving before API replies and their recalls never enter the cache | 旧预期 | resend_self=true 时，助手输出被真实撤回可以重发一次；输出回显不能再次触发控制。原用例禁止所有输出进入撤回缓存，与该显式开关冲突。 |
| 23 | `private-privacy.test.mjs` — sensitive or uncertain remains local: health/我生病了，这是诊断报告 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 24 | `private-privacy.test.mjs` — sensitive or uncertain remains local: health/My diagnosis | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 25 | `private-privacy.test.mjs` — sensitive or uncertain remains local: health/最近总失眠，不想告诉别人 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 26 | `private-privacy.test.mjs` — sensitive or uncertain remains local: finance/我的银行卡余额和贷款 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 27 | `private-privacy.test.mjs` — sensitive or uncertain remains local: finance/工资是5000，负债很多 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 28 | `private-privacy.test.mjs` — sensitive or uncertain remains local: finance/My salary an | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 29 | `private-privacy.test.mjs` — sensitive or uncertain remains local: identity/我姓张，叫张三 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 30 | `private-privacy.test.mjs` — sensitive or uncertain remains local: identity/My passport | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 31 | `private-privacy.test.mjs` — sensitive or uncertain remains local: sensitive/我的宗教信仰和性取向 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 32 | `private-privacy.test.mjs` — sensitive or uncertain remains local: sensitive/我和女朋友分手了 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 33 | `private-privacy.test.mjs` — sensitive or uncertain remains local: sensitive/公司客户资料请保密 | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 34 | `private-privacy.test.mjs` — sensitive or uncertain remains local: invalid/你好​ | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 35 | `private-privacy.test.mjs` — context scans user and assistant turns; prior sensitive data blocks benign follow-up | 旧预期 | 隐私规则识别具体凭据、标识值和无效控制字符；健康/财务等话题名及零宽排版字符本身不是秘密。用户上下文中的具体凭据仍被拒绝，未证实来源的助手历史仍被拒绝。 |
| 36 | `vision-source.test.mjs` — recent lookup cannot cross author or conversation and a real group @ remains required | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 37 | `vision-source.test.mjs` — multiple candidates ask for an explicit single-picture quote and never guess newest | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 38 | `vision-source.test.mjs` — quoted cross_group cannot produce a model image request and next text recovers | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 39 | `vision-source.test.mjs` — quoted missing_group cannot produce a model image request and next text recovers | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 40 | `vision-source.test.mjs` — quoted wrong_sender cannot produce a model image request and next text recovers | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 41 | `vision-source.test.mjs` — quoted expired cannot produce a model image request and next text recovers | 夹具问题 | 图像定位保留时间随 context_ttl_minutes；默认0不按时间删除。10分钟引用过期和2分钟缓存过期用例需明确设置该有限值。 |
| 42 | `vision-source.test.mjs` — quoted multi cannot produce a model image request and next text recovers | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 43 | `vision-source.test.mjs` — two-minute cache expiry, capacity eviction and clear cannot silently choose a discarded candidate | 夹具问题 | 图像定位保留时间随 context_ttl_minutes；默认0不按时间删除。10分钟引用过期和2分钟缓存过期用例需明确设置该有限值。 |
| 44 | `vision.test.mjs` — unsolicited, stale, history, quoted and multiple pictures cannot become a model image request | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 45 | `vision.test.mjs` — vision download fails explicitly once and the next text proceeds | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 46 | `vision.test.mjs` — vision timeout fails explicitly once and the next text proceeds | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 47 | `vision.test.mjs` — vision unsupported fails explicitly once and the next text proceeds | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 48 | `vision.test.mjs` — vision incomplete fails explicitly once and the next text proceeds | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 49 | `vision.test.mjs` — credentials recognized in OCR result are not delivered or committed to history | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
| 50 | `vision.test.mjs` — explicit common captions work; reply-only request gets a truthful current-image notice without fetching history | 旧预期 | 图像缺失、歧义、下载/模型错误或OCR凭据内容保留在本地诊断，不发送为QQ聊天。旧用例等待错误QQ回复而超时。 |
