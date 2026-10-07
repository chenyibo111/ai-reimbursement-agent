import { Navigate, Route, Routes } from "react-router-dom";

import { ClaimWorkbenchPage } from "./routes/claim-workbench-page";
import { ClaimListPage } from "./routes/claims-list-page";
import { PolicyRulesPage } from "./routes/policy-rules-page";
import { ReviewCenterPage } from "./routes/review-center-page";

export function App() {
  return <Routes>
    <Route path="/claims" element={<ClaimListPage />} />
    <Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} />
    <Route path="/admin/policies" element={<PolicyRulesPage />} />
    <Route path="/admin/reviews" element={<ReviewCenterPage />} />
    <Route path="*" element={<Navigate to="/claims" replace />} />
  </Routes>;
}
