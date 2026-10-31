import { INGESTION_POLICY as policy } from '../../domain/ingestion/policy.js';
import { newSourceTask } from '../../domain/ingestion/task.js';
import type { IngestionDependencies } from './ports.js';
import { DiscoveryService } from './registration.js';
export class SourceSchedulerService {
  constructor(
    private readonly d: IngestionDependencies,
    private readonly discover: DiscoveryService,
  ) {}
  async execute(): Promise<void> {
    if (!this.d.networkEnabled) return;
    const due = await this.d.unitOfWork.run(async (c) => {
      const repo = this.d.repositories(c);
      const stream = await repo.lockStream('new');
      const now = await repo.now();
      return (
        !stream.snapshot().pauseReason &&
        stream.snapshot().nextDiscoveryAt <= now
      );
    });
    if (due)
      await this.discover.execute({
        sourceKey: 'zhidianmijin',
        stream: 'new',
        runId: this.d.id(),
        pageLimit: 5,
      });
    await this.d.unitOfWork.run(async (c) => {
      const repo = this.d.repositories(c);
      const stream = await repo.lockStream('new');
      if (stream.snapshot().pauseReason) return;
      const now = await repo.now();
      const resources = (await repo.listResources())
        .filter((r) => r.snapshot().nextRefreshAt <= now)
        .slice(0, policy.maximumMaintenance);
      for (const resource of resources) {
        const state = resource.snapshot();
        const version = state.currentVersionId
          ? await repo.getVersion(state.currentVersionId)
          : null;
        await repo.insertTaskIfAbsent(
          newSourceTask(
            this.d.id(),
            `scheduled:${state.id}:${Math.floor(now.getTime() / policy.urgentMs)}`,
            `fetch:${state.id}`,
            { kind: 'fetch', resourceId: state.id },
            now,
            resource.refreshPriority(version?.snapshot().body ?? null, now),
          ),
        );
      }
    });
  }
}
