# 第四步：工程基础交付检查

状态：第四步已由用户“我已检查完成，继续实现”明确验收，本地工程提交2d2f003。本页及102个测试报告记录该提交时的历史快照，后续账号实现见[第五步交付](../auth/README.md)，当前进度以实施计划为准。

## 本步完成内容

- 建立本地Git与pnpm Monorepo：web、api、agent、worker四应用，contracts、business、agent-core、config、observability、testing六共享包。
- TypeScript、React/Vite、NestJS、Zod、PostgreSQL/Prisma锁定版本；正式workspace与第三步验证工具隔离。
- 建立公共幂等、提交后任务登记、审计迁移。UnitOfWork只向Service暴露不透明上下文，Prisma类型不离开持久化基础设施，Repository只返回Entity。
- 复合唯一约束和原子插入避免先查后建竞争；同键不同请求由Entity拒绝，事务结束的上下文不能重用。
- API/Agent共4个健康操作，各自具备契约、输入、故障、认证及作用域测试；维护[机器清单](../../tests/interface-registry.json)，源码AST发现未登记接口时检查失败。
- 健康响应带请求标识，日志不记录正文/认证头/错误详情；Agent独立运行，仅检查业务服务健康，不访问模型或数据库。
- 私有文件端口支持受保护写入、读取和幂等删除，拒绝路径穿越与符号链接；尚未实现业务上传接口。
- 前端连接检查、Worker运行容器、实际服务启动和关闭已验证。Worker尚不执行业务任务。

## 测试和运行范围

| 类别           | 结果   | 核对内容                                                                                                           |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| 单元/接口      | 17通过 | 4个接口、配置、领域、私有文件、日志和质量检查器                                                                    |
| PostgreSQL集成 | 5通过  | Entity映射、提交、回滚、上下文失效、两个独立连接的并发唯一性、冲突与公共表                                         |
| 浏览器/进程E2E | 3通过  | 浏览器到API/数据库，API/Agent/Worker实际启动，重启后持久化，断库503/存活200及恢复，错误配置，隔离空库迁移回退/重建 |
| 第三步工具回归 | 77通过 | 保留原验证能力，不调用真实模型或来源                                                                               |
| 质量检查       | 已通过 | generate/build、格式、Lint、类型、架构边界及逐接口测试清单                                                         |

最终复验共16项检查均退出0，命令、退出码、时间及源码摘要见[检查记录](checks.json)。[单元/接口报告](unit-tests.json)、[PostgreSQL集成报告](integration-tests.json)和[浏览器/进程E2E报告](e2e-tests.json)单独保存。总计102个测试，不能把第三步77个替身回归当成新增业务接口已实现。

## 修正及环境限制

- 最初浏览器E2E未进入用例：继承的NO_PROXY通配符在部分HTTP库不匹配回环IP，现仅在测试子进程显式加入127.0.0.1与localhost。
- Chromium首次启动缺少运行库；无免密sudo，未修改系统。通过apt-get download将libnspr4/libnss3/libasound2t64解压在/tmp，以LD_LIBRARY_PATH运行真实Chromium。相关命令见[启动与复现](../../README.md)。
- pnpm12使用allowBuilds明确允许必要构建脚本；不使用已移除的旧配置项。Prisma稳定版7.10.1通过Node24编译及真实PostgreSQL验证。
- 新workspace会影响祖先配置查找，已为历史验证工具增加独立Vitest/Prettier配置，保留原源码风格，不改真实请求预算。
- 临时数据库使用内存文件系统、独立随机回环端口和新建career_test库。曾产生的本轮匿名测试卷已按Docker事件中明确的测试容器归属清理，不删除未知卷；最终复验只创建临时容器，不触碰已有pgsql-local。
- E2E的回退演练只在可丢弃空测试库执行，不提供生产清表/回退命令。正式上线的数据回退和部署仍在后续步骤。

## 待用户检查

1. [工程结构与本地运行](../../README.md)是否符合预期。
2. [工程方案](../design/foundation.md)和上述分层、事务、权限边界是否匹配。
3. 检查报告及本地提交；通过后再处理第五步账号方案，不能由本步自动进入业务实现。

本轮未请求真实模型/来源、未配置远端、未推送或部署。第三步原始公开HTML和虚构文档仅保存在本地并被Git忽略；对应源码、报告、证据摘要及协作范围说明保留。用户密钥和Cookie留在本地忽略文件，未进入Git。

参考已核对的官方实现文档：[Nest测试编译](https://docs.nestjs.com/recipes/swc)、[Prisma7配置](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference)、[pnpm构建脚本配置](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/build.md)、[Playwright测试服务器](https://playwright.dev/docs/test-webserver)。
