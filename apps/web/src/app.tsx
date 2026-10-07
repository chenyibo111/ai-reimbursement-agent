import { Navigate, Route, Routes } from "react-router-dom";

import { ClaimWorkbenchPage } from "./routes/claim-workbench-page";
import { ClaimListPage } from "./routes/claims-list-page";

export function App() {
  return <Routes>
    <Route path="/claims" element={<ClaimListPage />} />
    <Route path="/claims/:claimId" element={<ClaimWorkbenchPage />} />
    <Route path="*" element={<Navigate to="/claims" replace />} />
  </Routes>;
}
