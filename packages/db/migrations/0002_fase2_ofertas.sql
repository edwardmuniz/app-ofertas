CREATE TABLE "affiliate_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"credentials" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_validations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"ok" boolean NOT NULL,
	"price_was" numeric(12, 2) NOT NULL,
	"price_now" numeric(12, 2),
	"available" boolean,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"affiliate_account_id" uuid NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"original_price" numeric(12, 2),
	"discount_pct" integer,
	"coupon_code" text,
	"coupon_description" text,
	"commission_rate" numeric(6, 4),
	"commission_value" numeric(12, 2),
	"affiliate_url" text,
	"score" integer DEFAULT 0 NOT NULL,
	"quality_flags" text[] DEFAULT '{}' NOT NULL,
	"notes" text,
	"reject_reason" text,
	"valid_until" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"saved_search_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"original_price" numeric(12, 2),
	"source" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"image_urls" text[] DEFAULT '{}' NOT NULL,
	"shop_name" text,
	"category_ids" text[] DEFAULT '{}' NOT NULL,
	"category_name" text,
	"rating" numeric(3, 2),
	"sold_count" integer,
	"last_price" numeric(12, 2),
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"interval_minutes" integer DEFAULT 60 NOT NULL,
	"min_score" integer DEFAULT 60 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliate_accounts" ADD CONSTRAINT "affiliate_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_validations" ADD CONSTRAINT "offer_validations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_affiliate_account_id_affiliate_accounts_id_fk" FOREIGN KEY ("affiliate_account_id") REFERENCES "public"."affiliate_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_points" ADD CONSTRAINT "price_points_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliate_accounts_workspace_id_index" ON "affiliate_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "offer_validations_offer_id_checked_at_index" ON "offer_validations" USING btree ("offer_id","checked_at");--> statement-breakpoint
CREATE INDEX "offers_workspace_id_status_created_at_index" ON "offers" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "offers_product_id_index" ON "offers" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "price_points_product_id_captured_at_index" ON "price_points" USING btree ("product_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_workspace_id_platform_external_id_index" ON "products" USING btree ("workspace_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "saved_searches_workspace_id_index" ON "saved_searches" USING btree ("workspace_id");