import type { ReactNode } from "react";

import { AgentConversationWidget } from "@/src/ui/agent-conversation-widget";

export default function AuthenticatedLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>{children}<AgentConversationWidget /></>;
}
