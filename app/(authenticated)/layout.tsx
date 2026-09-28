import type { ReactNode } from "react";

import { AgentConversationWidget } from "@/src/ui/agent-conversation-widget";
import { ReviewCenterNavigation } from "@/src/ui/review-center-navigation";

export default async function AuthenticatedLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <>{children}<ReviewCenterNavigation /><AgentConversationWidget /></>;
}
