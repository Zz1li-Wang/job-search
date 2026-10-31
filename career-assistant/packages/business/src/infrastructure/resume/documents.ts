import { RESUME_POLICY } from '@career/contracts';
import { createRequire } from 'node:module';
import * as mammoth from 'mammoth';
import { BusinessError } from '../../domain/shared/errors.js';
import type { TextSpan } from '@career/contracts';
export const DOCUMENT_LIMITS = {
  bytes: RESUME_POLICY.maxFileBytes,
  pages: RESUME_POLICY.maxPages,
  characters: RESUME_POLICY.maxCharacters,
  uncompressed: RESUME_POLICY.maxUncompressedBytes,
  zipEntries: RESUME_POLICY.maxZipEntries,
} as const;
/** 检查ZIP中央目录与累计解压大小；拒绝ZIP64、加密及路径异常。 */
export function validateDocxContainer(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length)
    throw new BusinessError('FILE_INVALID');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16),
    sum = 0,
    hasDocument = false;
  if (count > DOCUMENT_LIMITS.zipEntries || count === 65535)
    throw new BusinessError('FILE_TOO_LARGE');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new BusinessError('FILE_INVALID');
    if (bytes.readUInt16LE(offset + 8) & 1)
      throw new BusinessError('FILE_ENCRYPTED');
    const size = bytes.readUInt32LE(offset + 24),
      nameLength = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32);
    sum += size;
    if (size === 0xffffffff || sum > DOCUMENT_LIMITS.uncompressed)
      throw new BusinessError('FILE_TOO_LARGE');
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString();
    if (name.includes('..') || name.startsWith('/'))
      throw new BusinessError('FILE_INVALID');
    if (name === 'word/document.xml') hasDocument = true;
    offset += 46 + nameLength + extra + comment;
    if (offset > end) throw new BusinessError('FILE_INVALID');
  }
  if (!hasDocument) throw new BusinessError('FILE_INVALID');
}
export async function extractDocument(
  content: Uint8Array,
  format: 'pdf' | 'docx' | 'txt',
): Promise<TextSpan[]> {
  if (content.length > DOCUMENT_LIMITS.bytes)
    throw new BusinessError('FILE_TOO_LARGE');
  const bytes = Buffer.from(content);
  let spans: TextSpan[] = [];
  if (format === 'txt') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BusinessError('FILE_INVALID');
    }
    if (text.includes('\0')) throw new BusinessError('FILE_INVALID');
    spans = text
      .split(/\r?\n/)
      .map((text, i) => ({ locator: `paragraph:${i + 1}`, text }));
  } else if (format === 'docx') {
    validateDocxContainer(bytes);
    try {
      const extracted = await mammoth.extractRawText({ buffer: bytes });
      spans = extracted.value.split(/\n\s*\n/).map((text, i) => ({
        locator: `paragraph:${i + 1}`,
        text: text.trim(),
      }));
    } catch {
      throw new BusinessError('FILE_INVALID');
    }
  } else {
    if (bytes.subarray(0, 5).toString() !== '%PDF-')
      throw new BusinessError('FILE_INVALID');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl = createRequire(import.meta.url)
      .resolve('pdfjs-dist/package.json')
      .replace(/package\.json$/, 'standard_fonts/');
    const loading = getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl,
    });
    try {
      const document = await loading.promise;
      if (document.numPages > DOCUMENT_LIMITS.pages)
        throw new BusinessError('FILE_TOO_LARGE');
      let characters = 0;
      for (let page = 1; page <= document.numPages; page++) {
        const content = await (await document.getPage(page)).getTextContent();
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ');
        characters += text.length;
        if (characters > DOCUMENT_LIMITS.characters)
          throw new BusinessError('FILE_TOO_LARGE');
        spans.push({ locator: `page:${page}`, text });
      }
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError(
        error instanceof Error && error.name === 'PasswordException'
          ? 'FILE_ENCRYPTED'
          : 'FILE_INVALID',
      );
    } finally {
      await loading.destroy();
    }
  }
  const text = spans
    .map((s) => s.text)
    .join('\n')
    .trim();
  if (!text) throw new BusinessError('FILE_NO_TEXT');
  if (text.length > DOCUMENT_LIMITS.characters || spans.length > 3000)
    throw new BusinessError('FILE_TOO_LARGE');
  return spans.filter((s) => s.text.trim());
}
