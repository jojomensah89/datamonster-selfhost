-- The plan is billed through Polar. Its events carry whole states and can arrive late, so remember how new each one was.
ALTER TABLE plan_subscriptions ADD COLUMN source_at INTEGER NOT NULL DEFAULT 0;  -- when the state we have was true at Polar
-- status and until are Polar's word on the subscription. A refund of its newest payment is kept apart from that, so neither can undo the other.
ALTER TABLE plan_subscriptions ADD COLUMN refunded_at INTEGER; -- NULL unless the payment in payment_id was refunded in full
ALTER TABLE plan_subscriptions ADD COLUMN payment_at INTEGER NOT NULL DEFAULT 0; -- when the order in payment_id was made
