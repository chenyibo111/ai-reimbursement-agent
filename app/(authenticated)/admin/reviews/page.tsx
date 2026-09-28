import type { Metadata } from "next";

import { ReviewCenter } from "@/src/ui/review-center";

export const metadata: Metadata = { title: "复核中心 — AI 报销" };

export default function ReviewsPage() {
  return <ReviewCenter />;
}
