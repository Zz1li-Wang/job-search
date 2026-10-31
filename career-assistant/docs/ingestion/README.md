# 第六步：采集、证据和更新交付检查

状态：采集方案0.2已确认，模块已验收。用户在079d85d交付后回复“继续”，记录为第六步通过；第七步仅准备方案，实现未开始。用户在df71a44方案交付后回复“继续”，批准本模块及最多40次真实来源验证，未授权持续真实采集、外站扩展、推送或部署。

## 功能与操作入口

- 发现校招、社招和类型未知岗位；程序抽取公开字段、正文定位、公告及外站入口，未知条件不转为不限。
- 独立Worker执行任务，支持分页检查点、数据库唯一约束、租约、续租、有限退避、暂停恢复及迟到写入拒绝。扩展原TaskOutbox，不重复建立任务系统。
- 正文、获取观察、核验记录分开保存；同正文复查复用版本并增加观察，正文或关联公告变化撤销当前核验。
- 运营通过受保护的本地命令核验证据；完整性、版本向量和精确引用由领域对象校验，未核验草稿不生效。
- 用户可请求岗位刷新、查询本人关联任务；运行中较晚请求形成可追踪后继，不因共用任务丢失刷新请求。
- 公开覆盖统计区分已获取、完整已核验与当前新鲜，记录暂停和积压；导出固定视图、当前及历史正文/观察/核验，重复导出保留相同摘要。
- 新发现目标2小时、通常复查24小时、临近截止2小时；截止与过期判断在读取时计算，不依赖定时器恰好运行。API/Worker检查新增存储是否就绪。

| 操作     | 入口                          | 身份与测试                                   |
| -------- | ----------------------------- | -------------------------------------------- |
| 请求刷新 | POST /api/v1/jobs/:id/refresh | 当前用户+Origin+CSRF+Idempotency-Key；JOB-04 |
| 查询任务 | GET /api/v1/tasks/:id         | 当前用户且关联该任务；TASK-01                |
| 覆盖说明 | GET /api/v1/trust             | 公开聚合字段；PUBLIC-01                      |
| 发现登记 | collect discover              | 服务器运营身份；OPS-01                       |
| 核验原文 | evidence review               | 版本和精确引用；OPS-02                       |
| 数据导出 | data export                   | 服务器固定目录；OPS-03                       |
| 人工重试 | task retry                    | 预期attempt和恢复类别；OPS-04                |

[HTTP清单](../../tests/interface-registry.json)与[维护清单](../../tests/maintenance-registry.json)均由静态检查器关联具体可执行测试。MCP入口和岗位查询页面留待后续模块，本模块E2E通过真实CLI和Worker进程完成。

## 本地运行

先按[根README](../../README.md)安装、构建并迁移。根.env配置保持0600，增加.env.example中的INGESTION变量。网络默认关闭，普通启动不访问来源；不要为重跑更换预算ID。API不读取Cookie文件，Worker只在显式开启来源网络时读取，不登录、不自动续期。

维护命令在可信服务器执行，运营身份由INGESTION_OPERATOR_REFERENCE提供，输入来自JSON文件。示例输入不含秘密：

```json
{
  "sourceKey": "zhidianmijin",
  "stream": "new",
  "runId": "8d6e8ccc-0477-4e23-8f6b-ae41f478f3b2",
  "pageLimit": 1
}
```

```sh
pnpm build
pnpm db:migrate
# 在根.env设置INGESTION_OPERATOR_REFERENCE后，登记任务；默认网络关闭时只登记。
node scripts/with-env.mjs node apps/worker/dist/main.js collect discover /absolute/path/discover.json
# 各命令均使用最后一个参数指定JSON文件。
node scripts/with-env.mjs node apps/worker/dist/main.js evidence review /absolute/path/review.json
node scripts/with-env.mjs node apps/worker/dist/main.js data export /absolute/path/export.json
node scripts/with-env.mjs node apps/worker/dist/main.js task retry /absolute/path/retry.json
pnpm dev:worker
```

核验、重试及导出输入契约见[已确认方案第8节](../design/ingestion.md)。新导出输入为scope=all和operationKey；复现时只传existingExportId。命令成功退出0，输入问题2，版本或幂等冲突3，来源/存储问题4。生产来源持续运行仍未开启；不是把本步40次验证额度转换为长期采集许可。

## 真实来源验证

[当前报告](source-validation.json)、[逐请求账本](source-request-ledger.jsonl)、[实际数据导出](source-data.json)和[社招正文证据](social-evidence.json)分别保存事实。本步累计27次来源请求，历史第三步26次不变，总计53次；模型仍5次，本步没有调用DeepSeek。

当前真实结果：规范入口/jobs和认证第2页均解析出10个岗位；已知社招详情解析为social；正式Service、隔离PostgreSQL、快照和导出链路保存4个校招及1个社招岗位。真实数据的完整核验数为0，新鲜可肯定推荐数为0；没有用测试运营核验冒充真实资格核验。社招样本来自第三步真实URL，并在本轮重新获取，不是虚构岗位。

[首次报告](source-validation-attempt1.json)曾将加载占位页误判为空列表，不能视为有效扫描证据；已保留并修正。[第二次报告](source-validation-attempt2.json)用已验证的第2页补充入库验证；后经2次诊断确认：带page=1的地址返回占位结构，规范入口/jobs返回实际岗位。当前代码使用规范第一页入口；无岗位链接且无明确空结果时返回解析失败，不推进检查点。[诊断结构摘要](parser-diagnosis.jsonl)不含认证HTML或Cookie。

27次预算包含robots、重读、失败和诊断，剩余额度13次未使用。原始认证列表不落盘；公开详情也只保留去敏正文和摘要。原导出文件保留原字节，便于与报告中的exportDigest核对。没有验证全站覆盖、完整分页、外站原文、长期会话或持续更新吞吐。

## 检查记录

[最终检查](checks.json)17项全部通过，区间2026-10-30T15:30:27.953Z至2026-10-30T15:32:19.246Z（仅为该次检查运行时间）。总计180个测试：

| 测试                      | 结果   | 证据                                                                 |
| ------------------------- | ------ | -------------------------------------------------------------------- |
| 单元、契约和领域          | 42通过 | [JSON](unit-tests.json)                                              |
| 真实PostgreSQL、HTTP和CLI | 54通过 | [JSON](integration-tests.json)                                       |
| 浏览器和实际进程E2E       | 7通过  | [JSON](e2e-tests.json)；含2条采集完整/失败恢复链路及5条账号/工程回归 |
| 原外部验证工具回归        | 77通过 | 独立工具测试入口，历史模型/来源账本摘要未变                          |

检查包括生成、构建、格式、Lint、类型、架构、13个HTTP操作、4个维护命令、分层测试、E2E和Git空白。依赖frozen-lockfile安装通过；源码、迁移和测试SHA256见checks.json。数据库和命令验证只使用独立临时库，未修改已有pgsql-local或正式业务数据。

发现并修正：主机许可/导出互斥的PostgreSQL void返回值需要转为Prisma支持的类型；跨模块Guard依赖需明确导出，启动异常改为可捕获而非中止进程；发现加载占位页不能视为空列表；正式雇主标记补充为detail-employer-name（已用公开历史样本结构离线回归，真实取样时缺失单位仍保持null，不篡改旧导出）；运行中的刷新与暂停任务可合并；历史流重试必须清除对应流暂停；数据库在更新语句内再次检查租约与token，阻止事务期间过期写入。

测试数据全部是隔离库和明确标记的虚构夹具；真实来源数据与夹具分开。没有上线或持续采集，交付当时停止等待第六步验收；随后用户“继续”通过，当前状态见开头。

来源适配采用[parse5](https://parse5.js.org/modules/parse5.html)和[robots-parser](https://github.com/samclarke/robots-parser)，网络采用[Node HTTPS](https://nodejs.org/api/https.html)。实际Node24兼容性由本项目构建和真实来源取样验证。同域当前采用更保守的串行主机许可，响应结束后至少1秒再启动，仍满足最多2并发上限；Worker可同时编排2个任务。后续提高吞吐需保留这些时间及预算约束。

## 后续本地运行

用户随后明确要求启用Worker，已按原40次额度对账并运行首批采集，当前本机状态见[本地Worker启用记录](local-worker.md)。本页第六步的27次、53次累计、默认未启用等为当时交付历史，不能当作之后的实时运行状态。
