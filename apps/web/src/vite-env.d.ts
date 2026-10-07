/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REIMBURSEMENT_API_BASE_URL?: string;
  readonly VITE_REIMBURSEMENT_DEV_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
