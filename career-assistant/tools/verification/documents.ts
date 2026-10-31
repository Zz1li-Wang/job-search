import { ProbeErrorCode } from "./error-codes.ts";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createRequire } from "node:module";
import * as mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { DOCUMENT_POLICY, ProbeError } from "./domain.ts";
import type { TextSpan } from "./dto.ts";

/** DOCX先检查ZIP中央目录，拒绝资源膨胀、ZIP64和不完整文档。 */
export function validateDocxContainer(bytes: Buffer): void {
  let uncompressed = 0;
  let entries = 0;
  let hasDocument = false;
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length)
    throw new ProbeError(ProbeErrorCode.InvalidDocx);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (count > 2048) throw new ProbeError(ProbeErrorCode.DocxResourceLimit);
  while (entries < count) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new ProbeError(ProbeErrorCode.InvalidDocx);
    const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    uncompressed += size;
    if (
      uncompressed > DOCUMENT_POLICY.maxUncompressedBytes ||
      size === 0xffffffff
    )
      throw new ProbeError(ProbeErrorCode.DocxResourceLimit);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString();
    if (name === "word/document.xml") hasDocument = true;
    offset +=
      46 +
      nameSize +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
    entries += 1;
  }
  if (!hasDocument) throw new ProbeError(ProbeErrorCode.InvalidDocx);
}

/** 只提取文字与定位；不识别学历等语义，不使用OCR，也不访问外部资源。 */
export async function extractDocument(path: string): Promise<TextSpan[]> {
  const bytes = await readFile(path);
  const extension = extname(path).toLowerCase();
  if (bytes.length > DOCUMENT_POLICY.maxBytes)
    throw new ProbeError(ProbeErrorCode.DocumentTooLarge);
  let spans: TextSpan[];
  if (extension === ".pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new ProbeError(ProbeErrorCode.DocumentSignatureMismatch);
    const standardFontDataUrl = createRequire(import.meta.url)
      .resolve("pdfjs-dist/package.json")
      .replace(/package\.json$/, "standard_fonts/");
    const loading = getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl,
    });
    let pdf;
    try {
      pdf = await loading.promise;
    } catch (error) {
      await loading.destroy();
      throw new ProbeError(
        error instanceof Error && error.name === "PasswordException"
          ? ProbeErrorCode.EncryptedPdf
          : ProbeErrorCode.InvalidPdf,
      );
    }
    spans = [];
    try {
      if (pdf.numPages > DOCUMENT_POLICY.maxPages)
        throw new ProbeError(ProbeErrorCode.DocumentPageLimit);
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        spans.push({
          locator: `page:${pageNumber}`,
          text: content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        });
      }
    } finally {
      await loading.destroy();
    }
  } else if (extension === ".docx") {
    if (bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4b50)
      throw new ProbeError(ProbeErrorCode.DocumentSignatureMismatch);
    validateDocxContainer(bytes);
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    spans = extracted.value
      .split(/\n\s*\n/)
      .map((text, index) => ({
        locator: `paragraph:${index + 1}`,
        text: text.trim(),
      }))
      .filter((span) => span.text);
  } else if (extension === ".txt") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ProbeError(ProbeErrorCode.InvalidTextEncoding);
    }
    if (text.includes("\0"))
      throw new ProbeError(ProbeErrorCode.DocumentSignatureMismatch);
    spans = text.split(/\r?\n/).map((line, index) => ({
      locator: `paragraph:${index + 1}`,
      text: line,
    }));
  } else throw new ProbeError(ProbeErrorCode.DocumentFormatUnsupported);
  const text = spans
    .map((span) => span.text)
    .join("\n")
    .trim();
  if (!text) throw new ProbeError(ProbeErrorCode.NoExtractableText);
  if (Array.from(text).length > DOCUMENT_POLICY.maxCharacters)
    throw new ProbeError(ProbeErrorCode.DocumentCharacterLimit);
  return spans;
}
