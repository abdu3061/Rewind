import { crc32, deflateRawSync } from "node:zlib";

/** Small, entirely synthetic ZIP writer. Never reads user files. */
export function zipFixture(
  entries: {
    name: string;
    text: string;
    deflate?: boolean;
    crc?: number;
    flags?: number;
    declared?: number;
  }[],
): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      original = Buffer.from(entry.text);
    const content = entry.deflate ? deflateRawSync(original) : original;
    const data =
      entry.flags && entry.flags & 1
        ? Buffer.concat([Buffer.alloc(12), content])
        : content;
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(entry.crc ?? crc32(original), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.declared ?? original.length, 22);
    header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50);
    header.copy(directory, 6, 4, 26);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const table = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, table, end]);
}

export const wordNs =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export function docxEntries(
  body: string,
  options: {
    namespace?: string;
    target?: string;
    mode?: string;
    type?: string;
    raw?: boolean;
  } = {},
) {
  return [
    {
      name: "_rels/.rels",
      text: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${options.target ?? "word/document.xml"}"${options.mode ? ` TargetMode="${options.mode}"` : ""}/></Relationships>`,
    },
    {
      name: "[Content_Types].xml",
      text: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${options.type ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"}"/></Types>`,
    },
    {
      name: "word/document.xml",
      text: options.raw
        ? body
        : `<w:document xmlns:w="${options.namespace ?? wordNs}"><w:body>${body}</w:body></w:document>`,
      deflate: true,
    },
  ];
}

/** Ordinary PDF with real offsets, shared Helvetica and synthetic content only. */
export function pdfFixture(
  pages: string[] = ["Synthetic PDF evidence"],
  encrypted = false,
): Buffer {
  const objects: string[] = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: string[] = [];
  for (const text of pages) {
    const id = objects.length;
    kids.push(`${id} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    const escaped = text.replace(/[\\()]/g, (char) => `\\${char}`);
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  const encryptionId = objects.length;
  if (encrypted)
    objects.push(
      `<< /Filter /Standard /V 2 /Length 128 /R 3 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`,
    );
  return writePdf(
    objects,
    encrypted
      ? ` /Encrypt ${encryptionId} 0 R /ID [<${"01".repeat(16)}><${"01".repeat(16)}>]`
      : "",
  );
}
export function imageOnlyPdfFixture(): Buffer {
  const stream = "q 10 0 0 10 72 720 cm /Im0 Do Q";
  return writePdf([
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nrgb\nendstream",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]);
}
function writePdf(objects: string[], extraTrailer = ""): Buffer {
  let value = "%PDF-1.7\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets.push(Buffer.byteLength(value));
    value += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  value += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  value += `trailer\n<< /Size ${objects.length} /Root 1 0 R${extraTrailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
