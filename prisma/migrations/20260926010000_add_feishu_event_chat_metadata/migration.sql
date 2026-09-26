ALTER TABLE "InboundChannelEvent"
  ADD COLUMN "chatType" TEXT NOT NULL DEFAULT 'p2p',
  ADD COLUMN "mentionedOpenIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
