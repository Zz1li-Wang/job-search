import { ProbeErrorCode } from "./error-codes.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import PDFKit from "pdfkit";
import { Document, Packer, Paragraph } from "docx";

/** 全部简历为虚构测试资料，不进入真实岗位或真实用户库。 */
export const SAMPLE_LINES = [
  "FICTIONAL TEST RESUME",
  "Name: Test Student",
  "Education: Bachelor, Computer Science, Expected graduation: 2027-06",
  "Internship: Example Lab, 2026-07 to 2026-08",
  "Certificate: English CET-6",
  "正式工作经历：无。实习不能当作正式工作年限。",
];
export interface Fixture {
  id: string;
  path: string;
  expected: "readable" | "rejected";
  expectedCode?: string;
}
export async function createFixtures(directory: string): Promise<Fixture[]> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "resume.txt"), SAMPLE_LINES.join("\n"));
  const docx = new Document({
    sections: [{ children: SAMPLE_LINES.map((line) => new Paragraph(line)) }],
  });
  await writeFile(join(directory, "resume.docx"), await Packer.toBuffer(docx));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage();
  SAMPLE_LINES.slice(0, 5).forEach((line, index) =>
    page.drawText(line, { x: 30, y: 780 - index * 30, size: 11, font }),
  );
  await writeFile(join(directory, "resume.pdf"), await pdf.save());
  const imagePdf = await PDFDocument.create();
  const image = await imagePdf.embedPng(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  imagePdf.addPage().drawImage(image, { x: 20, y: 20, width: 50, height: 50 });
  await writeFile(join(directory, "image-only.pdf"), await imagePdf.save());
  const encrypted = new PDFKit({
    userPassword: "fixture-password",
    ownerPassword: "fictional-owner-password",
    pdfVersion: "1.7",
  });
  const chunks: Buffer[] = [];
  const encryptedBytes = new Promise<Buffer>((resolve, reject) => {
    encrypted.on("data", (chunk: Buffer) => chunks.push(chunk));
    encrypted.on("end", () => resolve(Buffer.concat(chunks)));
    encrypted.on("error", reject);
  });
  encrypted.text("FICTIONAL ENCRYPTED TEST RESUME").end();
  await writeFile(join(directory, "encrypted.pdf"), await encryptedBytes);
  await writeFile(
    join(directory, "oversize.txt"),
    Buffer.alloc(10 * 1024 * 1024 + 1, 65),
  );
  await writeFile(join(directory, "forged.pdf"), "Not a PDF");
  await writeFile(
    join(directory, "invalid-utf8.txt"),
    Buffer.from([0xff, 0xfe, 0xff]),
  );
  return [
    ...["txt", "docx", "pdf"].map((format): Fixture => ({
      id: `text-${format}`,
      path: join(directory, `resume.${format}`),
      expected: "readable",
    })),
    ...[
      ["image-only.pdf", ProbeErrorCode.NoExtractableText],
      ["encrypted.pdf", ProbeErrorCode.EncryptedPdf],
      ["oversize.txt", ProbeErrorCode.DocumentTooLarge],
      ["forged.pdf", ProbeErrorCode.DocumentSignatureMismatch],
      ["invalid-utf8.txt", ProbeErrorCode.InvalidTextEncoding],
    ].map(([name, code]): Fixture => ({
      id: name,
      path: join(directory, name),
      expected: "rejected",
      expectedCode: code,
    })),
  ];
}
