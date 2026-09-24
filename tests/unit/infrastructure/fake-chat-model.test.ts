import { expect, it } from "vitest";

import { FakeChatModel } from "@/src/infrastructure/model/fake-chat-model";

it("suggests a purpose only when the server permits the claim target", async () => {
  await expect(new FakeChatModel().decide({ message: "客户拜访", claimId: "private", summary: { allowedTargets: [{ target: "claim", fields: ["purpose"] }] }, issues: [] })).resolves.toMatchObject({ proposals: [{ target: "claim", field: "purpose", value: "客户拜访" }] });
});
