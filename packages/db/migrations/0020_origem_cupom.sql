ALTER TABLE "offers" ADD COLUMN "coupon_source" text;--> statement-breakpoint
UPDATE "offers" SET "coupon_source" = 'manual' WHERE "coupon_code" IS NOT NULL;
