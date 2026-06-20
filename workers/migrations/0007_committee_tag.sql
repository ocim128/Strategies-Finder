-- Committee membership tag. A subscription is a committee member iff
-- committee_tag IS NOT NULL. NULL for plain alert subscriptions so the
-- Alerts tab and the Signal Committee tab can coexist on the same table.
-- Multiple committees may share one tag value in the future; v1 treats all
-- tagged rows as one committee.
ALTER TABLE signal_subscriptions ADD COLUMN committee_tag TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_subscriptions_committee_tag
    ON signal_subscriptions(committee_tag)
    WHERE committee_tag IS NOT NULL;
