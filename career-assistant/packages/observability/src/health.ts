import type { HealthDto, HealthQueryDto } from '@career/contracts';

export interface DependencyProbe {
  /** 固定名称不含用户或连接信息，检查不得改变业务状态。 */
  readonly name: string;
  isAvailable(): Promise<boolean>;
}
/** 健康用例只编排明确的依赖端口，无业务数据查询和模型推理。 */
export class HealthService {
  constructor(
    readonly service: HealthDto['service'],
    readonly probes: readonly DependencyProbe[],
  ) {}
  live(_query: HealthQueryDto): HealthDto {
    return { service: this.service, status: 'ok', dependencies: {} };
  }
  async ready(_query: HealthQueryDto): Promise<HealthDto> {
    const checks = await Promise.all(
      this.probes.map(async (probe) => {
        try {
          return [probe.name, await probe.isAvailable()] as const;
        } catch {
          return [probe.name, false] as const;
        }
      }),
    );
    const dependencies = Object.fromEntries(checks);
    return {
      service: this.service,
      status: checks.every(([, available]) => available) ? 'ok' : 'unavailable',
      dependencies,
    };
  }
}
