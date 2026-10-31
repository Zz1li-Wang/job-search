import type { ModelResult } from "./dto.ts";

/** 仅检查配置是否齐备，不读取其他应用凭据，也不代替真实能力验证。 */
export function inspectModelConfiguration(
  environment: NodeJS.ProcessEnv,
): ModelResult {
  const names = [
    "MODEL_BASE_URL",
    "MODEL_NAME",
    "MODEL_API_KEY",
    "MODEL_PROTOCOL",
  ];
  const missingConfiguration = names.filter(
    (name) => !environment[name]?.trim(),
  );
  return {
    status: missingConfiguration.length ? "blocked" : "not_run",
    summary: missingConfiguration.length
      ? `缺少配置：${missingConfiguration.join("、")}；真实请求数为0。`
      : "配置存在；本配置检查没有发起真实请求，能力以probeModel结果为准。",
    requestCount: 0,
    missingConfiguration,
    evidenceFiles: [],
    limitations: [
      "配置检查不能证明结构化、流式或工具能力。",
      "真实验证由已确认的提供商适配器执行，不能把非空配置当作已接通。",
    ],
  };
}
