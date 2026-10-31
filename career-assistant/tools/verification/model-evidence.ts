import { z } from "zod";
import type { TextSpan } from "./dto.ts";
import { ModelFailure, ModelProbeError } from "./model-contracts.ts";

export const ExtractionSchema = z.strictObject({
  name: z.string().describe("简历姓名"),
  degree: z.string().describe("规范学历标识"),
  major: z.string().describe("规范专业标识"),
  expectedGraduation: z.string().describe("预计毕业年月，不冒充已毕业"),
  formalExperienceYears: z
    .number()
    .nonnegative()
    .describe("正式工作年限，不含实习"),
  hasInternship: z.boolean().describe("是否明确有实习"),
  evidence: z
    .array(
      z.strictObject({
        field: z
          .enum([
            "name",
            "degree",
            "major",
            "expectedGraduation",
            "formalExperienceYears",
            "hasInternship",
          ])
          .describe("被证据支持的字段"),
        locator: z.string().describe("原段落定位"),
        quote: z.string().min(1).describe("逐字原文片段"),
      }),
    )
    .describe("每个字段必须有原文依据"),
});
export const AuditSchema = z.strictObject({
  school: z.null().describe("原文没有学校，不得猜测"),
  birthDate: z.null().describe("原文没有生日"),
  phone: z.null().describe("原文没有电话"),
  formalExperienceYears: z.number().describe("只计正式工作"),
  graduationKind: z.string().describe("预计或实际毕业"),
  evidenceQuote: z.string().min(1).describe("正式工作结论的逐字依据"),
});

/** 仅判定固定虚构夹具，不能当作生产用户画像或资格判断引擎。 */
export class ResumeProbeEvidence {
  readonly spans: readonly TextSpan[];
  constructor(spans: readonly TextSpan[]) {
    this.spans = spans;
  }
  validateExtraction(input: unknown): z.infer<typeof ExtractionSchema> {
    const parsed = ExtractionSchema.safeParse(input);
    if (!parsed.success) throw new ModelProbeError(ModelFailure.Facts);
    const facts = parsed.data;
    if (
      facts.name !== "Test Student" ||
      facts.degree !== "bachelor" ||
      facts.major !== "computer_science" ||
      facts.expectedGraduation !== "2027-06" ||
      facts.formalExperienceYears !== 0 ||
      facts.hasInternship !== true
    )
      throw new ModelProbeError(ModelFailure.Facts);
    const required = [
      "name",
      "degree",
      "major",
      "expectedGraduation",
      "formalExperienceYears",
      "hasInternship",
    ];
    if (
      !required.every((field) =>
        facts.evidence.some((entry) => entry.field === field),
      )
    )
      throw new ModelProbeError(ModelFailure.Facts);
    for (const entry of facts.evidence) {
      const span = this.spans.find((span) => span.locator === entry.locator);
      const expected = {
        name: { locator: "paragraph:2", token: "Test Student" },
        degree: { locator: "paragraph:3", token: "Bachelor" },
        major: { locator: "paragraph:3", token: "Computer Science" },
        expectedGraduation: { locator: "paragraph:3", token: "2027-06" },
        formalExperienceYears: {
          locator: "paragraph:6",
          token: "正式工作经历：无",
        },
        hasInternship: { locator: "paragraph:4", token: "Internship" },
      }[entry.field];
      if (
        !span?.text.includes(entry.quote) ||
        entry.locator !== expected.locator ||
        !entry.quote.includes(expected.token)
      )
        throw new ModelProbeError(ModelFailure.Facts);
    }
    return facts;
  }
  validateAudit(input: unknown): z.infer<typeof AuditSchema> {
    const parsed = AuditSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.formalExperienceYears !== 0 ||
      parsed.data.graduationKind !== "expected" ||
      !parsed.data.evidenceQuote.includes("正式工作经历：无") ||
      !this.spans.some((span) => span.text.includes(parsed.data.evidenceQuote))
    )
      throw new ModelProbeError(ModelFailure.Facts);
    return parsed.data;
  }
}
