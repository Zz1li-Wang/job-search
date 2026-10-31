# Monorepo 和公共基础方案

版本0.1；用户在上一轮获得第三步结果和本方案链接、第四步内容说明后回复“继续”，记录为第三步按披露范围验收通过，并确认开始本工程基础方案。对应第四步，不授权后续业务模块。

## 初始化与正常异常路径

```mermaid
flowchart TD
    U[用户确认工程方案] --> G[确认独立目录并初始化本地Git]
    G -->|权限或身份受阻| FAIL[报告阻塞 不修改系统权限或伪造提交身份]
    G --> P[建立pnpm workspace和四应用基础]
    P --> C[配置Schema校验与服务启动]
    C -->|缺少必须配置| BAD[启动失败并仅指出配置名]
    C --> DB[测试数据库迁移]
    DB -->|迁移失败| STOP[不启动新应用 数据保留]
    DB --> H[各服务存活及就绪检查]
    H --> T[质量检查集成测试架构检查]
    T --> REVIEW[本地提交及交付用户检查]
```

公共实现：HealthController → 无敏感输入 HealthQueryDto → HealthService → DatabaseProbePort / RuntimeStatus → HealthDto。健康检查不绕过 Repository 访问业务记录；Probe 属基础设施诊断接口，只返回依赖是否可用，不返回 DSN 或错误堆栈。Agent 存活/就绪不消耗模型费用，就绪表示配置和必要工具服务可用，不代表模型实时一定正常。

配置由 `config` Zod Schema 校验；入口只注入模块所需配置。明确区分模型、数据库、文件路径、服务身份、时限和版本标识。依赖版本在执行时依据兼容性锁定，不使用未锁定 latest；NestJS 装饰器元数据与 Vitest 转译需用小型启动测试证明兼容，失败先修测试配置不换业务规则。

`business` 导出 DTO Service 端口、领域对象及基础设施装配入口；禁止导出 Prisma 类型。UnitOfWork.run 接收不透明 TxContext，Repository 绑定该上下文。事务只能由应用 Service 开始/结束；异常使整个回调回滚。公共事务验证用测试夹具表，不以未获批业务用例“顺手实现”作为演示。

```mermaid
flowchart LR
    HTTP[健康入口或测试入口] --> DTO[Zod DTO]
    DTO --> S[HealthService或测试用例Service]
    S --> U[UnitOfWork端口]
    U --> AD[Prisma事务适配器内部上下文]
    S --> R[Repository端口]
    R --> M[内部Mapper与Prisma实现]
    M --> DB[(PostgreSQL)]
    S --> OUT[Health或测试专用输出DTO]
```

初始迁移只包含必要公共任务/幂等/审计能力与测试支持；业务迁移随模块提交。第七步提供画像只读基础关系，尚无数据时返回空，不把不存在的业务模型列为已实现。

## 公共质量和测试

提供 format:check、lint、typecheck、test、test:integration、test:e2e、build 和接口覆盖清单校验命令，实际命令在锁定工程后写 README。Lint 检查层级和跨包路径、禁止非基础设施导入 Prisma。依赖矩阵和 DTO 作为契约包的唯一来源，字段说明可审查。

PostgreSQL 测试使用隔离数据库或 schema，测试结束清理；不能连生产数据库跑迁移/清表。E2E 通过真实 HTTP、MCP、Worker，外部模型和来源可控；静态 docs 校验与代码用例分开。

HEALTH-01—04 均有接口测试。E2E-FOUNDATION 从进程启动、迁移、就绪、事务写入/回滚、重启读取到退出清理；数据库断开时存活 200、就绪 503，不能泄漏连接信息。并发测试使用两个独立连接，不能串行测试冒充竞争验证。无远端提交或发布。

## 执行细化与提交范围

按既有方案建立四应用和六共享包。公共健康HTTP保持/health/live与/health/ready；API公开、Agent需服务Bearer凭据及health:read作用域，均返回requestId和HealthDto；未知/内部异常不得暴露配置。Worker本步只启动运行容器，不消费尚未实现的业务任务。Web本步只展示API健康状态，不出现未实现的求职功能。

初始持久化采用幂等记录、提交后任务登记和审计表；任务执行器随第六步实现。以幂等Repository/Entity与测试专用Service验证UnitOfWork、唯一约束及并发，测试流程不增加生产HTTP入口。私有文件端口及本地适配器验证路径边界和幂等删除，不提前实现上传API。

集成和E2E各自创建专用临时PostgreSQL容器，数据库名带test标识，只监听127.0.0.1随机端口，测试结束删除本轮容器；不使用或修改已有pgsql-local容器。迁移回退只在隔离空测试库演练，业务库不自动执行破坏性回退。源码、契约、迁移、检查脚本和对应测试同属本步提交。

实现采用明确依赖注入和生产编译验证Nest元数据；自动测试不调用真实模型或来源。既有第三步工具作为历史独立工具保留并回归，私有env、依赖、报告中的原始HTML/虚构文件不加入本地Git。远端不配置、不推送。
