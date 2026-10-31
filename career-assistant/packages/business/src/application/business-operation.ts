import { BusinessError } from '../domain/shared/errors.js';
import { AuthError } from '../domain/auth/errors.js';
import { IngestionError } from '../domain/ingestion/errors.js';
import { IdempotencyConflictError } from '../domain/idempotency.js';
export async function businessOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof BusinessError ||
      error instanceof AuthError ||
      error instanceof IngestionError
    )
      throw error;
    if (error instanceof IdempotencyConflictError)
      throw new BusinessError('IDEMPOTENCY_CONFLICT');
    throw new BusinessError('DEPENDENCY_UNAVAILABLE');
  }
}
