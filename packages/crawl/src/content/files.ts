// Documents as Markdown: PDF (text per page), Word (DOCX) and spreadsheets (XLSX).

export type FileKind = "pdf" | "docx" | "xlsx";

export function fileKind(contentType: string, url: string): FileKind | undefined {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (/application\/pdf/i.test(contentType) || path.endsWith(".pdf")) return "pdf";
  if (/wordprocessingml/i.test(contentType) || path.endsWith(".docx")) return "docx";
  if (/spreadsheetml/i.test(contentType) || path.endsWith(".xlsx")) return "xlsx";
  return undefined;
}

async function pdfMarkdown(body: Buffer): Promise<{ markdown: string; title?: string }> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(body));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((page) => page.trim());
  const meta = await getMeta(pdf).catch(() => undefined);
  const title = (meta?.info as { Title?: string } | undefined)?.Title;
  const markdown = pages
    .map((page, index) => (pages.length > 1 ? `## Page ${index + 1}\n\n${page}` : page))
    .join("\n\n");
  return title ? { markdown, title } : { markdown };
}

async function docxMarkdown(body: Buffer): Promise<{ markdown: string }> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.convertToHtml({ buffer: body });
  const { toMarkdown } = await import("./html.js");
  return { markdown: toMarkdown(value) };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const record = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (record.richText) return record.richText.map((part) => part.text).join("");
    if (record.text !== undefined) return String(record.text);
    if (record.result !== undefined) return cellText(record.result);
  }
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function xlsxMarkdown(body: Buffer): Promise<{ markdown: string }> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body as never);
  const sheets: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map(cellText)));
    if (!rows.length) return;
    const width = Math.max(...rows.map((row) => row.length));
    const line = (row: string[]) =>
      `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
    sheets.push(
      [
        `## ${sheet.name}`,
        "",
        line(rows[0] ?? []),
        `|${" --- |".repeat(width)}`,
        ...rows.slice(1).map(line),
      ].join("\n"),
    );
  });
  return { markdown: sheets.join("\n\n") };
}

export async function fileToMarkdown(
  kind: FileKind,
  body: Buffer,
): Promise<{ markdown: string; title?: string }> {
  if (kind === "pdf") return pdfMarkdown(body);
  if (kind === "docx") return docxMarkdown(body);
  return xlsxMarkdown(body);
}
