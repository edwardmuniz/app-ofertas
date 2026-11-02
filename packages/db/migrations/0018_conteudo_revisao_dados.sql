ALTER TABLE "contents" ADD COLUMN "offer_prices" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Vídeos montados pelo servidor antes da revisão: passam pela aprovação como os do agente.
UPDATE "contents" SET "status" = 'pending_review' WHERE "kind" = 'video' AND "status" = 'ready' AND "reviewed_at" IS NULL;--> statement-breakpoint
UPDATE "contents" SET "status" = 'failed', "error" = 'O servidor não monta mais vídeos: peça ao agente local.' WHERE "kind" = 'video' AND "status" IN ('queued', 'rendering');
