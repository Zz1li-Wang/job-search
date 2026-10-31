import {
  DiscoverInputSchema,
  ReviewInputSchema,
  RetryInputSchema,
  ExportInputSchema,
} from '@career/contracts';
import {
  IngestionError,
  AuthError,
  type IngestionServices,
} from '@career/business';
import { z } from 'zod';
export const MAINTENANCE_OPERATIONS = Object.freeze([
  'collect discover',
  'evidence review',
  'data export',
  'task retry',
]);
/** 一个命令对应一个Service用例，输入JSON由协议层验证。 */
export async function executeMaintenance(
  services: IngestionServices,
  command: string,
  input: unknown,
  operatorReference: string,
): Promise<{ exitCode: number; output: unknown }> {
  if (!operatorReference)
    return {
      exitCode: 2,
      output: {
        error: { code: 'OPERATOR_REQUIRED', message: '请配置服务器运营身份' },
      },
    };
  try {
    let output: unknown;
    switch (command) {
      case 'collect discover':
        output = await services.discover.execute(
          DiscoverInputSchema.parse(input),
        );
        break;
      case 'evidence review':
        output = await services.review.execute(ReviewInputSchema.parse(input));
        break;
      case 'data export':
        output = await services.export.execute(ExportInputSchema.parse(input));
        break;
      case 'task retry':
        output = await services.retry.execute(RetryInputSchema.parse(input));
        break;
      default:
        return {
          exitCode: 2,
          output: {
            error: { code: 'UNKNOWN_COMMAND', message: '未知维护命令' },
          },
        };
    }
    return { exitCode: 0, output };
  } catch (error) {
    if (error instanceof z.ZodError)
      return {
        exitCode: 2,
        output: {
          error: { code: 'INVALID_INPUT', message: '维护命令输入不符合契约' },
        },
      };
    if (error instanceof IngestionError)
      return {
        exitCode: error.code.includes('CONFLICT')
          ? 3
          : error.code === 'EVIDENCE_INCOMPLETE'
            ? 2
            : 4,
        output: { error: { code: error.code, message: error.message } },
      };
    if (error instanceof AuthError)
      return {
        exitCode: 4,
        output: { error: { code: error.code, message: error.message } },
      };
    return {
      exitCode: 4,
      output: {
        error: {
          code: 'INGESTION_STORAGE_UNAVAILABLE',
          message: '维护命令暂不可用',
        },
      },
    };
  }
}
