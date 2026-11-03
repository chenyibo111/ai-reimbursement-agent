CREATE TABLE "sso_web_sessions" (
    "id_hash" VARCHAR(64) NOT NULL,
    "employee_id" TEXT NOT NULL,
    "sid" VARCHAR(255) NOT NULL,
    "encrypted_id_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sso_web_sessions_pkey" PRIMARY KEY ("id_hash")
);

CREATE INDEX "sso_web_sessions_sid_idx" ON "sso_web_sessions"("sid");
