import { expect, it } from "vitest";

import { processFeishuEvent, type ProcessFeishuEventDeps } from "@/src/application/process-feishu-event";

function attachmentDeps(overrides: Partial<ProcessFeishuEventDeps> = {}) {
  const calls = { download: 0, upload: 0, extract: 0 };
  const deps: ProcessFeishuEventDeps = {
    botOpenId: "ou-bot",
    publicAppUrl: "https://reimbursement.example.test",
    events: {
      findInboundByEventId: async () => ({ eventId: "event-1", messageId: "om-1", messageType: "image", chatId: "oc-1", senderOpenId: "ou-employee" }),
      findEmployeeByOpenId: async () => ({ id: "employee-1" }),
      getConversation: async () => null,
      setConversation: async () => undefined,
    },
    client: {
      getMessage: async () => ({ messageId: "om-1", chatId: "oc-1", chatType: "p2p", senderOpenId: "ou-employee", messageType: "image", text: "", mentions: [], attachments: [{ fileKey: "img-1", resourceType: "image", filename: "receipt.jpg" }] }),
      downloadResource: async () => {
        calls.download += 1;
        return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), filename: "receipt.jpg", mimeType: "image/jpeg" };
      },
      replyText: async () => undefined,
      replyCard: async () => undefined,
    },
    createClaimDraft: async () => ({ id: "claim-1", employeeId: "employee-1", status: "DRAFT", purpose: null, version: 0 }),
    runAgentTurn: async () => ({ reply: "unused", clarifications: [], proposals: [] }),
    uploadReceipt: async (input) => {
      calls.upload += 1;
      expect(input).toMatchObject({ actorId: "employee-1", claimId: "claim-1", filename: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) });
      return { id: "receipt-1", claimId: "claim-1", objectKey: "never-returned", originalFilename: input.filename, contentHash: "hash", mimeType: input.mimeType, status: "PENDING" };
    },
    extractReceipt: async (input) => {
      calls.extract += 1;
      expect(input).toEqual({ actorId: "employee-1", claimId: "claim-1", receiptId: "receipt-1" });
      return { receiptId: "receipt-1", expenseItemCreated: true, validationIssues: [] };
    },
    ...overrides,
  };
  return { deps, calls };
}

it("downloads an attachment and reuses the existing upload and extraction pipeline", async () => {
  const { deps, calls } = attachmentDeps();

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({
    kind: "ATTACHMENT_QUEUED",
    claimId: "claim-1",
    receiptId: "receipt-1",
    receiptStatus: "EXTRACTED",
    filename: "receipt.jpg",
  });
  expect(calls).toEqual({ download: 1, upload: 1, extract: 1 });
});

it("does not download an attachment for an employee that has not completed Web OAuth binding", async () => {
  const { deps, calls } = attachmentDeps({ events: { ...attachmentDeps().deps.events, findEmployeeByOpenId: async () => null } });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({ kind: "LOGIN_REQUIRED" });
  expect(calls.download).toBe(0);
  expect(calls.upload).toBe(0);
});

it("rejects oversized, unsupported, and signature-mismatched downloads before storing them", async () => {
  const samples = [
    { bytes: new Uint8Array(20 * 1024 * 1024 + 1), mimeType: "image/jpeg" },
    { bytes: new Uint8Array([1, 2]), mimeType: "text/plain" },
    { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
  ];
  for (const sample of samples) {
    const { deps, calls } = attachmentDeps({
      client: { ...attachmentDeps().deps.client, downloadResource: async () => ({ ...sample, filename: "receipt.bin" }) },
    });
    const result = await processFeishuEvent({ eventId: "event-1" }, deps);
    expect(result).toMatchObject({ kind: "RETRYABLE_FAILURE" });
    expect(calls.upload).toBe(0);
  }
});

it("preserves the created draft and reports a safe retry response when download or OCR fails", async () => {
  const download = attachmentDeps({ client: { ...attachmentDeps().deps.client, downloadResource: async () => { throw new Error("upstream private details"); } } });
  await expect(processFeishuEvent({ eventId: "event-1" }, download.deps)).resolves.toMatchObject({ kind: "RETRYABLE_FAILURE", claimId: "claim-1" });
  expect(download.calls.upload).toBe(0);

  const ocr = attachmentDeps({ extractReceipt: async () => { throw new Error("ocr response with object key"); } });
  const result = await processFeishuEvent({ eventId: "event-1" }, ocr.deps);
  expect(result).toMatchObject({ kind: "RETRYABLE_FAILURE", claimId: "claim-1" });
  expect(JSON.stringify(result)).not.toContain("object key");
  expect(ocr.calls.upload).toBe(1);
});

it("does not overwrite a Web update when the existing extraction pipeline reports a version conflict", async () => {
  const { deps, calls } = attachmentDeps({ extractReceipt: async () => { throw new Error("version conflict"); } });

  await expect(processFeishuEvent({ eventId: "event-1" }, deps)).resolves.toMatchObject({ kind: "RETRYABLE_FAILURE", claimId: "claim-1" });
  expect(calls.upload).toBe(1);
});
