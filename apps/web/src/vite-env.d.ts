/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REIMBURSEMENT_API_BASE_URL?: string;
  readonly VITE_AUTH_BFF_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
