ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS selected_expense_categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS expense_categories_source TEXT NOT NULL DEFAULT 'AUTO'
    CHECK (expense_categories_source IN ('AUTO', 'MANUAL'));

UPDATE reimbursement.claims AS claim
SET selected_expense_categories = COALESCE((
  SELECT array_agg(category ORDER BY category)
  FROM (
    SELECT DISTINCT item.expense_category AS category
    FROM reimbursement.expense_items AS item
    JOIN reimbursement.receipts AS receipt ON receipt.id = item.receipt_id
    WHERE item.claim_id = claim.id AND receipt.status = 'EXTRACTED' AND item.expense_category <> ''
  ) AS recognized
), ARRAY[]::TEXT[])
WHERE claim.itemization_mode = 'ITEMIZED' AND claim.expense_categories_source = 'AUTO';
