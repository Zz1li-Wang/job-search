import type { IngestionDependencies } from './ports.js';
import {
  DiscoveryService,
  RefreshService,
  TaskQueryService,
  TaskRetryService,
} from './registration.js';
import { SourceExecutionService } from './execution.js';
import { EvidenceReviewService } from './review.js';
import {
  CoverageService,
  DataExportService,
  SnapshotMaintenanceService,
} from './reporting.js';
import { SourceSchedulerService } from './scheduler.js';
export function createIngestionServices(d: IngestionDependencies) {
  const discover = new DiscoveryService(d);
  return {
    discover,
    refresh: new RefreshService(d),
    task: new TaskQueryService(d),
    retry: new TaskRetryService(d),
    execution: new SourceExecutionService(d),
    review: new EvidenceReviewService(d),
    coverage: new CoverageService(d),
    export: new DataExportService(d),
    maintenance: new SnapshotMaintenanceService(d),
    scheduler: new SourceSchedulerService(d, discover),
  };
}
export type IngestionServices = ReturnType<typeof createIngestionServices>;
