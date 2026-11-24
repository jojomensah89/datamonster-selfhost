-- The Overview cards shown for a site and their order, as JSON [{id, on}] (src/shared/dashboardCards.ts). NULL is the default.
ALTER TABLE sites ADD COLUMN dashboard_cards TEXT;
