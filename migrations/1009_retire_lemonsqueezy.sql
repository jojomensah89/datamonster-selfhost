-- LemonSqueezy support was removed (the platform is being sunset).
-- Clear stored signing secrets; the column stays so older migrations remain valid.
UPDATE sites SET lemonsqueezy_webhook_secret = NULL;
