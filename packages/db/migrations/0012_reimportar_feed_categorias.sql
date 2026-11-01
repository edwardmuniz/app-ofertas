-- Reimporta os feeds para preencher o nome da categoria principal (coluna nova em 0011).
UPDATE "affiliate_accounts" SET "feed_synced_at" = NULL WHERE "mode" = 'feed';
