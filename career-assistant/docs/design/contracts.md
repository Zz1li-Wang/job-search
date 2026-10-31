# 接口与数据契约提案

总体版本0.1，账号、采集及岗位资格提案契约0.2；HEALTH-01—04、AUTH-01—06以及第六步JOB-04/TASK-01/PUBLIC-01/OPS-01—04已实现，其余业务接口仍待对应模块确认与实现。以下 ID 用于设计和测试追踪，不进入生产注释或异常消息。字段业务描述将落实为 Zod describe / TSDoc，不以本文代替运行时校验。

账号模块的具体契约已细化为[账号实施方案0.2](auth.md)，已获模块确认并完成实现；本表AUTH行随该方案同步。验证码为6位23456789数字PNG，密码按Unicode码点限制长度；账号规则不得从旧的简表自行推测。

第六步的3个HTTP入口与OPS-01—04细化于[采集实施方案0.2第8节](ingestion.md)，已确认并实现且已验收；刷新body为严格空对象，jobId仅来自路径。采集条件草稿先用程序与证据定位，人工核验后方可生效，模型抽取待Agent能力具备后另行设计。

第七步6个新增HTTP操作（JOB-01—03、ELIG-01—02、PROFILE-01）细化于[岗位资格方案0.2](jobs-eligibility.md)，待用户确认、尚未实现。PROFILE-01只读基础纳入本步，画像写入仍在第九步；无正式画像为null/version0。EvaluateInput提案增加expectedReviewVersion与expectedEvidenceDependencyHash，学历/专业/例外元数据缺失时不能默认判为满足；具体兼容语义以方案为准。

## 公共约定

- 公共业务前缀 `/api/v1`；Agent `/internal/v1`；MCP 使用业务后端内部 `/mcp`，不暴露公网。
- 认证标记：P=公开；U=当前活跃用户；S=服务凭据及操作作用域（涉及用户运行另加运行授权）；O=服务器本地受保护 CLI。U 不能由请求体 userId 代替。
- HTTP JSON 成功为 `{ requestId, payload }`，分页 payload 为 `{ entries, nextCursor }`；204 无正文；SSE 和验证码图片 data URL 不套额外流包装。
- 错误 `{ requestId, error: { code, message, details? } }`；details 仅允许类型化字段问题/版本信息，不能输出堆栈或敏感内容。
- 400 结构/验证码/游标错误；401 未认证或错误凭据；403 CSRF、Origin、工具范围拒绝；404 不存在或非本人私有资源；409 幂等/版本/状态冲突；410 事件回放已不可用；413 超限；415 不支持类型；422 文件无法提取；429 限流；503 外部/数据库暂不可用；504 超时。资格未知/不符是成功的业务结果，不是 4xx。
- 所有 U/S 写操作验证身份上下文及适用的 CSRF/运行权限。GET 不推进状态。参数错误不能产生业务写入。
- 任务型创建返回 202 和已持久化 taskId/runId；未完成时不输出伪造结果。显式同步创建为 201；自然唯一资源已有返回 200。删除 204 或异步删除 202 按下表。
- 支持幂等记录的操作在表中标 K，使用 Idempotency-Key（UUID）；相同身份/操作/键和相同内容返回原结果，内容不同 409。自然唯一键和 clientMessageId 另行标明。

## DTO 词汇表

所有 ID 为 UUID，时间 ISO 8601；以下可选字段标 `?`。HTTP 路径参数也作为输入 DTO 校验。

| DTO或类型                  | 字段与业务约束                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| CaptchaDto                 | captchaId、imageDataUrl、expiresAt、csrfToken；不含答案                                                                                         |
| RegisterInput / LoginInput | username 3—32 ASCII 字母数字下划线、password 12—128 Unicode码点且UTF-8最多512字节、captchaId、captchaAnswer为23456789中的6位数字                |
| UserDto                    | id、username、createdAt、csrfToken；无密码/哈希/会话值                                                                                          |
| PasswordInput              | currentPassword、newPassword；成功撤销全部会话                                                                                                  |
| PageQuery                  | limit 默认20 最大100；cursor? 绑定筛选；字符串查询 trim 后最多100字符                                                                           |
| UploadResumeInput          | multipart file；10 MiB；请求头 K；校验签名、页数、字符数和容器解压限制                                                                          |
| TextResumeInput            | text 1—50,000字符、label? 最多100字符；K                                                                                                        |
| ResumeDto                  | id、label、format、version、status、parseTaskId?、draftId?、errorCode?、createdAt；不含私有路径                                                 |
| ResumeContentDto           | resumeId、resumeVersion、spans[{locator, text}]；仅本人，定位为页或段                                                                           |
| ParseInput                 | resumeId、expectedVersion、retryOfAttemptId?；K，明确重试才新执行尝试                                                                           |
| ProfileContent             | educationEntries、formalEmploymentEntries、internshipEntries、skills、certificates、jobPreferences；未提供为unknown，不虚构空值含义             |
| EducationEntry             | school?、major?、degree?、awardStatus(studying/awarded/unknown)、graduationDate?、dateKind(expected/actual/unknown)、source?                    |
| ExperienceEntry            | organization?、role?、startDate?、endDate?、isCurrent、description?、source?；正式工作和实习分别放置                                            |
| SourceRef                  | resumeId?、sourceVersion、locator、原文字段；源已删时只保留不可访问标记                                                                         |
| ProfileDto                 | content 或 null、version、confirmedAt?；从未确认时 version=0                                                                                    |
| DraftInput / DraftPatch    | content、baseProfileVersion；Patch 另有expectedDraftVersion；K                                                                                  |
| DraftDto                   | id、draftVersion、baseProfileVersion、content、evidenceRefs、status、confirmedProfileVersion?                                                   |
| ConfirmDraftInput          | draftId、expectedDraftVersion、expectedProfileVersion；K                                                                                        |
| JobQuery                   | PageQuery；keyword?、city?、recruitmentType?、degree?；未知条件不能假设符合                                                                     |
| JobSummaryDto              | id、jobVersionId、title、company?、cities、recruitmentType、recordedAt、lastFetchedAt、deadline、availability、reviewState、freshness、warnings |
| JobDetailDto               | JobSummary + blocks、reviewId/reviewVersion、条件树/完整性/缺口、sourceLinks、关联公告、evidenceDependencyHash                                  |
| EvidenceDto / Bundle       | id、sourceUrl、sourceVersion、locator、excerpt、fetchedAt、verifiedAt?、reviewStatus、conflicts                                                 |
| EvaluateInput              | jobId、expectedJobVersion、expectedProfileVersion、expectedReviewVersion、expectedEvidenceDependencyHash；K；无画像版本0为待核验                |
| EligibilityDto             | checkId、status、checks[{requirement,evidenceIds,userFact,decision,missingFields}]、依赖版本、evaluatedAt、isCurrent、warnings                  |
| RefreshInput               | jobId为路径参数，body严格空对象；K；公共刷新去重；不接受任意URL                                                                                 |
| TaskDto                    | id、kind、status、attempt、updatedAt、errorCode?、relatedResourceId?；不得泄露其他用户任务                                                      |
| ConversationInput / Dto    | title? 最多100字符；输出id、title、createdAt、activeRunId?                                                                                      |
| MessageInput               | conversationId、clientMessageId、text 1—4,000字符、jobId?；同ID同内容返回原运行                                                                 |
| RunDto                     | id、conversationId、status、attempt、lastSequence、errorCode?；不含内部授权                                                                     |
| RetryRunInput              | runId、expectedRunVersion；K，只允许失败/中断运行，新attempt保持关联                                                                            |
| RunEventDto                | runId、sequence、type、payload；payload为按type判别的Zod联合，不是任意对象                                                                      |
| text_delta / citation      | 文本片段；引用为evidenceId及对应说明，只能引用工具返回证据                                                                                      |
| job_cards / profile_draft  | 后端核验过的岗位ID/资格记录ID列表；待确认draftId，不直接确认                                                                                    |
| completed / failed         | 最终消息ID及引用列表；失败含业务错误码和isRetryable，不含内部堆栈                                                                               |
| ApplicationInput           | jobId；K；已有返回原记录，不重置状态                                                                                                            |
| ApplicationPatch           | expectedVersion、status?、actionDate?、note? 最多2000字符；至少一项变化；K                                                                      |
| ApplicationDto             | id、jobId、jobSnapshot、status、actionDate?、note、version、createdAt、updatedAt                                                                |
| ApplicationHistoryDto      | 操作ID、oldStatus、newStatus、actionDate?、note、recordedAt                                                                                     |
| DeleteDataInput            | confirmation 固定业务枚举(delete_profile/delete_personal_data/delete_account)，账号另含currentPassword；K                                       |
| DeletionDto                | deletionRequestId、taskId、scope、status(pending_cleanup/completed)，说明访问已阻断                                                             |
| HealthDto / TrustDto       | status和必要依赖布尔值；实际岗位覆盖、采集/核验时间、缺口、说明版本，无敏感配置                                                                 |

ProfileContent 的数组元素及字段长度、日期格式、枚举成员语义在对应模块获批编码前落为独立字段 Schema；领域 Schema 与 DTO 不复用成同一对象。资格 conditions 使用 AND/OR/例外的判别联合类型，不能用自由文本 dict 承担可执行规则。

## HTTP 接口清单

表中每个 ID 在测试矩阵中有独立测试行。所有私有接口默认包含认证、他人数据不可读写、输入及错误映射测试。

| ID         | 方法与路径（省略/api/v1）        | 身份 | 输入 → 输出                                 | 幂等与关键行为                                                              |
| ---------- | -------------------------------- | ---- | ------------------------------------------- | --------------------------------------------------------------------------- |
| AUTH-01    | GET /auth/captcha                | P    | 无 → CaptchaDto                             | PNG独立新挑战、访客CSRF和浏览器绑定；限流、no-store，无答案                 |
| AUTH-02    | POST /auth/register              | P    | RegisterInput → 201 UserDto                 | 验证码原子消费，用户名唯一；重复409，不自动登录                             |
| AUTH-03    | POST /auth/login                 | P    | LoginInput → UserDto+Cookie                 | 错误统一401，验证码不复用                                                   |
| AUTH-04    | POST /auth/logout                | U*   | 无 → 204                                    | 当前/已撤销会话幂等退出；空Cookie有效Origin下无副作用204，其他私有入口仍401 |
| AUTH-05    | GET /auth/me                     | U    | 无 → UserDto                                | 无会话401，提供当前CSRF token                                               |
| AUTH-06    | PUT /auth/password               | U    | PasswordInput → 204                         | 原密码错401；成功撤销所有会话，不自动重试                                   |
| RES-01     | POST /resumes                    | U    | UploadResumeInput → 201/200 ResumeDto       | K+用户摘要去重；文件预存、任务登记分阶段                                    |
| RES-02     | POST /resumes/text               | U    | TextResumeInput → 201/200 ResumeDto         | K+摘要去重                                                                  |
| RES-03     | GET /resumes                     | U    | PageQuery → ResumeDto分页                   | 过滤已删数据                                                                |
| RES-04     | GET /resumes/:id                 | U    | id → ResumeDto                              | 状态与关联任务，非本人404                                                   |
| RES-05     | POST /resumes/:id/parse          | U    | ParseInput → 202 TaskDto                    | K；原任务可复用，显式retry新attempt                                         |
| RES-06     | DELETE /resumes/:id              | U    | id+K → 202 DeletionDto                      | 先逻辑删除；物理清理失败可恢复                                              |
| RES-07     | GET /resumes/:id/content         | U    | id → ResumeContentDto                       | 文本未就绪409，已删404                                                      |
| PROFILE-01 | GET /profile                     | U    | 无 → ProfileDto                             | 尚未确认为null和version=0                                                   |
| PROFILE-02 | POST /profile/drafts             | U    | DraftInput → 201 DraftDto                   | K；不改变正式画像                                                           |
| PROFILE-03 | PATCH /profile/drafts/:id        | U    | DraftPatch → DraftDto                       | K+draftVersion条件更新                                                      |
| PROFILE-04 | POST /profile/drafts/:id/confirm | U    | ConfirmDraftInput → ProfileDto+isCurrent    | K；重复确认原结果；画像冲突409                                              |
| PROFILE-05 | GET /profile/drafts/:id          | U    | id → DraftDto                               | 非本人或已删除404                                                           |
| JOB-01     | GET /jobs                        | U    | JobQuery → JobSummaryDto分页                | 只读、稳定游标                                                              |
| JOB-02     | GET /jobs/:id                    | U    | id → JobDetailDto                           | 下架仍显示历史和状态                                                        |
| JOB-03     | GET /jobs/:id/evidence           | U    | id、expectedJobVersion? → EvidenceBundleDto | 只读，个人简历证据不在公共岗位返回                                          |
| JOB-04     | POST /jobs/:id/refresh           | U    | RefreshInput → 202 TaskDto                  | K+公共活跃任务合并和限流                                                    |
| ELIG-01    | POST /eligibility-checks         | U    | EvaluateInput → 201 EligibilityDto          | K，保存依赖版本时再校验                                                     |
| ELIG-02    | GET /eligibility-checks/:id      | U    | id → EligibilityDto                         | 返回当前是否失效，不伪装新核验                                              |
| TASK-01    | GET /tasks/:id                   | U    | id → TaskDto                                | 本人私有任务或自己请求过的公共刷新                                          |
| CHAT-01    | POST /conversations              | U    | ConversationInput → 201 ConversationDto     | K，不重复建会话                                                             |
| CHAT-02    | GET /conversations               | U    | PageQuery → ConversationDto分页             | 不含已删会话                                                                |
| CHAT-03    | DELETE /conversations/:id        | U    | id+K → 202 DeletionDto                      | 取消运行并阻断回放，物理清理异步                                            |
| CHAT-04    | GET /conversations/:id/messages  | U    | id+PageQuery → MessageDto分页               | 含消息状态和引用，无内部提示词                                              |
| CHAT-05    | POST /conversations/:id/messages | U    | MessageInput → 202 RunDto                   | clientMessageId；不同新消息遇忙409                                          |
| CHAT-06    | GET /runs/:id                    | U    | id → RunDto                                 | 本人状态                                                                    |
| CHAT-07    | GET /runs/:id/events             | U    | id+Last-Event-ID? → SSE                     | 回放已提交事件；不存在游标400，已清理410                                    |
| CHAT-08    | POST /runs/:id/cancel            | U    | id+K → RunDto                               | 重复终结无副作用；迟到回调不恢复                                            |
| CHAT-09    | POST /runs/:id/retry             | U    | RetryRunInput → 202 RunDto                  | K+期望版本，不重试仍运行/成功状态                                           |
| FAV-01     | GET /favorites                   | U    | PageQuery → FavoriteDto分页                 | 仅本人，含岗位状态                                                          |
| FAV-02     | PUT /favorites/:jobId            | U    | jobId → 201/200 FavoriteDto                 | userId+jobId唯一                                                            |
| FAV-03     | DELETE /favorites/:jobId         | U    | jobId → 204                                 | 不存在也成功                                                                |
| APP-01     | GET /applications                | U    | PageQuery+status? → ApplicationDto分页      | 仅本人                                                                      |
| APP-02     | POST /applications               | U    | ApplicationInput → 201/200 ApplicationDto   | K+自然唯一，不重置已有记录                                                  |
| APP-03     | GET /applications/:id            | U    | id → ApplicationDto                         | 非本人404                                                                   |
| APP-04     | PATCH /applications/:id          | U    | ApplicationPatch → ApplicationDto           | K+CAS；历史和主记录同事务                                                   |
| APP-05     | GET /applications/:id/history    | U    | id+PageQuery → HistoryDto分页               | 时间和序号稳定排序                                                          |
| APP-06     | DELETE /applications/:id         | U    | id+K → 204                                  | 自有记录幂等删除，连同历史                                                  |
| PRIV-01    | DELETE /profile                  | U    | DeleteDataInput → 202 DeletionDto           | K；清空画像并失效相关核验                                                   |
| PRIV-02    | DELETE /me/data                  | U    | DeleteDataInput → 202 DeletionDto           | K；保留账号，清空个人求职数据                                               |
| PRIV-03    | DELETE /me                       | U    | DeleteDataInput → 202 DeletionDto           | K；验证当前密码并撤销会话                                                   |
| PUBLIC-01  | GET /trust                       | P    | 无 → TrustDto                               | 实际统计和局限，短缓存，不改时间                                            |
| HEALTH-01  | GET /health/live（API）          | P    | 无 → HealthDto                              | 进程存活，不泄露配置                                                        |
| HEALTH-02  | GET /health/ready（API）         | P    | 无 → HealthDto                              | 必需依赖失败503                                                             |
| HEALTH-03  | GET /health/live（Agent）        | S    | 无 → HealthDto                              | 内部访问，不消耗模型费用                                                    |
| HEALTH-04  | GET /health/ready（Agent）       | S    | 无 → HealthDto                              | 内部配置及工具服务就绪，无昂贵实时推理                                      |

MessageDto 为 id、conversationId、role(user/assistant)、text、runId?、status、citations、createdAt；FavoriteDto 为 jobId、createdAt、JobSummaryDto。二者通过 Service 映射，不返回持久化记录。

AUTH-04的U*例外仅用于退出：有Cookie必须校验CSRF，无Cookie不撤销其他会话；具体规则见账号方案0.2。

## 内部 Agent 操作

| ID     | 操作                                         | 输入 → 输出                                                                                                                | 失败与重复                                                             |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| INT-01 | POST /internal/v1/runs                       | RunStartDto(runId, conversation快照, 已确认画像, 预算, 受限授权) → Accepted(runId)                                         | S；同运行同摘要复用，篡改409；数据库/网络事务外                        |
| INT-02 | POST /internal/v1/runs/:id/events（API接收） | RunEventDto → ackSequence                                                                                                  | S；顺序条件写，重复同内容确认，不同内容或缺序409                       |
| INT-03 | GET /internal/v1/runs/:id（Agent）           | runId → 执行状态                                                                                                           | S且运行范围一致；重启后unknown明确返回，不伪称完成                     |
| INT-04 | POST /internal/v1/runs/:id/cancel（Agent）   | runId → 取消状态                                                                                                           | S；重复安全，本地取消先发生，外部失败不恢复权限                        |
| INT-05 | POST /internal/v1/resume-extractions         | ExtractionInput(resumeId,version,attemptId,baseProfileVersion,预算和受限授权) → ExtractionDto(ProfileContent,evidenceRefs) | S；read_resume取资料，返回结构化草稿，不直接确认或访问DB；超时显式中断 |

INT-02 以 API 的服务间身份保护，不能供浏览器发事件。INT-05 由 Worker 调用，任务记录由业务后端保存，模型未知结果不自动再次计费。

## MCP 工具

均经初始化、协商和调用测试，业务输入由 Zod 校验，输出为类型化 structuredContent。缺少/无效身份使用协议未认证错误；领域拒绝为稳定 code 的 isError 工具结果，非法协议参数按协议错误返回。返回不得含 ORM 或任意内部对象。

| ID     | Tool                   | 参数 → 输出                                  | 场景、权限、重复语义                                        |
| ------ | ---------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| MCP-01 | read_resume            | resumeId, expectedVersion → ResumeContentDto | 当前运行获准的本人简历；只读；未准备409、非本人404          |
| MCP-02 | get_profile            | 无 → ProfileDto                              | 本人正式画像；只读；无画像为null                            |
| MCP-03 | search_jobs            | JobQuery → JobSummaryDto分页                 | 候选搜索，不等于报名推荐；只读                              |
| MCP-04 | get_job_evidence       | jobId,expectedVersion → EvidenceDto列表      | 版本不符409；无任意URL抓取                                  |
| MCP-05 | evaluate_eligibility   | EvaluateInput+operationKey → EligibilityDto  | 复用同一业务Service；无画像时待核验；重复不生成新业务副作用 |
| MCP-06 | request_job_refresh    | jobId,operationKey → TaskDto                 | 合并来源刷新；受控限流；不能声称刷新已完成                  |
| MCP-07 | propose_profile_update | DraftInput+operationKey → DraftDto           | 只建待确认草稿，不覆盖正式画像；重复返回原草稿              |
| MCP-08 | get_task_status        | taskId → TaskDto                             | 仅当前身份允许的任务；只读，避免无限轮询超过工具预算        |

第八步仅开放已经实现的工具，第九步启用简历及画像草稿写工具。读画像基础和空值行为须先实现，不用“工具注册但总是假数据”占位。

## 维护与验证入口

| ID        | 入口             | 输入 → 输出                                                                  | 权限与重复                                                                                 |
| --------- | ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| OPS-01    | collect discover | 允许来源、游标?、runId → 发现任务和统计                                      | O；checkpoint和自然唯一键，不全站盲扫                                                      |
| OPS-02    | evidence review  | jobVersionId、expectedVersion、条件树、定位、完整性、操作者、理由 → 核验版本 | O；旧版本拒绝；同内容幂等；必须对照原文                                                    |
| OPS-03    | data export      | 范围和operationKey或已有exportId → 数据文件和manifest                        | O；固定视图生成exportId/snapshotAt；同exportId可复现，含全部实际获取记录及缺口，无个人资料 |
| OPS-04    | task retry       | taskId、expectedAttempt → 任务状态                                           | O；仅可重试类别；结果未知模型任务需明确确认，不盲目重放                                    |
| VERIFY-01 | source probe     | 允许来源及样本上限 → 来源验证报告                                            | 第三步方案获批后执行；失败标明缺口                                                         |
| VERIFY-02 | model probe      | Secret引用、能力样本 → 能力报告                                              | 不输出密钥；未真实调用不报成功                                                             |
| VERIFY-03 | document probe   | 虚构样本集合 → 提取及定位报告                                                | 无真实个人信息，无OCR回退                                                                  |

维护命令也经 DTO → Service → Entity / Repository（如涉及DB），输出可验证的结果。不因不是 HTTP 就跳过接口测试或设计确认。
