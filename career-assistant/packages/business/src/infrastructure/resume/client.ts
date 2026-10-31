import {
  ExtractionResultSchema,
  ErrorResponseSchema,
  ExtractionFailureCodeSchema,
  type ExtractionInputDto,
} from '@career/contracts';
import { BusinessError } from '../../domain/shared/errors.js';
export function createExtractionClient(baseUrl: string, token: string) {
  return async (input: ExtractionInputDto) => {
    const response = await fetch(
      new URL('/internal/v1/resume-extractions', baseUrl),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(125000),
      },
    );
    if (!response.ok) {
      let failure: unknown;
      try {
        failure = await response.json();
      } catch {
        /* 未知响应不推断为明确失败。 */
      }
      const envelope = ErrorResponseSchema.safeParse(failure);
      const code = ExtractionFailureCodeSchema.safeParse(
        envelope.success ? envelope.data.error.code : null,
      );
      throw new BusinessError(code.success ? code.data : 'MODEL_INTERRUPTED');
    }
    return ExtractionResultSchema.parse(await response.json());
  };
}
