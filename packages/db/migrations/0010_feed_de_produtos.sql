CREATE TABLE "feed_items" (
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"image_urls" text[] DEFAULT '{}' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"original_price" numeric(12, 2),
	"discount_pct" integer,
	"rating" numeric(3, 2),
	"likes" integer,
	"shop_name" text,
	"category_ids" text[] DEFAULT '{}' NOT NULL,
	"category_name" text,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feed_items_account_id_external_id_pk" PRIMARY KEY("account_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "affiliate_accounts" ADD COLUMN "feed_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_accounts" ADD COLUMN "feed_info" jsonb;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_account_id_affiliate_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."affiliate_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_items_account_id_discount_pct_index" ON "feed_items" USING btree ("account_id","discount_pct");