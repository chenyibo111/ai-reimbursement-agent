import { expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";

import { uploadReceipt } from "@/src/application/upload-receipt";

it("rejects a file whose signature does not match its declared type", async () => {
  const calls = { stored: 0, created: 0, scanned: 0 };

  await expect(
    uploadReceipt(
      {
        actorId: "employee-1",
        claimId: "claim-1",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
      },
      createDeps(calls),
    ),
  ).rejects.toThrow("file signature does not match declared type");

  expect(calls).toEqual({ stored: 0, created: 0, scanned: 0 });
});

it("stores a clean PDF under a private claim prefix and records its hash", async () => {
  const calls = { stored: 0, created: 0, scanned: 0, keys: [] as string[] };

  const receipt = await uploadReceipt(
    {
      actorId: "employee-1",
      claimId: "claim-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      bytes: await createPdfBytes(1),
    },
    createDeps(calls),
  );

  expect(calls.stored).toBe(1);
  expect(calls.keys[0]).toMatch(/^claims\/claim-1\/receipts\/[\w-]+\/[a-f0-9]{64}$/);
  expect(receipt).toMatchObject({ claimId: "claim-1", status: "PENDING", originalFilename: "invoice.pdf" });
  expect(receipt.contentHash).toHaveLength(64);
});

it("rejects a PDF with more than 20 pages before scanning or storage", async () => {
  const calls = { stored: 0, created: 0, scanned: 0 };

  await expect(
    uploadReceipt(
      {
        actorId: "employee-1",
        claimId: "claim-1",
        filename: "long.pdf",
        mimeType: "application/pdf",
        bytes: await createPdfBytes(21),
      },
      createDeps(calls),
    ),
  ).rejects.toThrow("PDF exceeds 20 pages");

  expect(calls).toEqual({ stored: 0, created: 0, scanned: 0 });
});

function createDeps(calls: { stored: number; created: number; scanned: number; keys?: string[] }) {
  return {
    claims: {
      getByIdOrThrow: async () => ({ employeeId: "employee-1" }),
    },
    scanner: {
      scan: async () => {
        calls.scanned += 1;
        return "CLEAN" as const;
      },
    },
    store: {
      put: async (input: { key: string }) => {
        calls.stored += 1;
        calls.keys?.push(input.key);
      },
    },
    receipts: {
      create: async (input: {
        id: string;
        claimId: string;
        objectKey: string;
        contentHash: string;
        mimeType: string;
        originalFilename: string;
        status: "PENDING";
      }) => {
        calls.created += 1;
        return input;
      },
    },
    audit: {
      append: async () => undefined,
    },
  };
}

async function createPdfBytes(pageCount: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) document.addPage();
  return document.save();
}
