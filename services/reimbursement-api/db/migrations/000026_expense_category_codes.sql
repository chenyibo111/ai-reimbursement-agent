ALTER TABLE reimbursement.claims
  ADD COLUMN IF NOT EXISTS selected_expense_category_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS expense_catalog_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS category_review_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE reimbursement.expense_items
  ADD COLUMN IF NOT EXISTS category_code TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS expense_catalog_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS category_review_required BOOLEAN NOT NULL DEFAULT FALSE;

WITH names AS (
  SELECT category->>'code' AS code, category->>'label' AS name
  FROM reimbursement.config_versions AS version
  CROSS JOIN LATERAL jsonb_array_elements(version.payload->'categories') AS category
  WHERE version.domain='expense_catalog' AND version.version=1
  UNION ALL
  SELECT category->>'code', alias #>> '{}'
  FROM reimbursement.config_versions AS version
  CROSS JOIN LATERAL jsonb_array_elements(version.payload->'categories') AS category
  CROSS JOIN LATERAL jsonb_array_elements(category->'aliases') AS alias
  WHERE version.domain='expense_catalog' AND version.version=1
), unique_names AS (
  SELECT name, min(code) AS code FROM names GROUP BY name HAVING count(DISTINCT code)=1
)
UPDATE reimbursement.expense_items AS item
SET category_code=COALESCE((SELECT code FROM unique_names WHERE name=item.expense_category), ''),
    category_review_required=NOT EXISTS (SELECT 1 FROM unique_names WHERE name=item.expense_category)
WHERE item.expense_category <> '' AND item.category_code='';

WITH names AS (
  SELECT category->>'code' AS code, category->>'label' AS name
  FROM reimbursement.config_versions AS version
  CROSS JOIN LATERAL jsonb_array_elements(version.payload->'categories') AS category
  WHERE version.domain='expense_catalog' AND version.version=1
  UNION ALL
  SELECT category->>'code', alias #>> '{}'
  FROM reimbursement.config_versions AS version
  CROSS JOIN LATERAL jsonb_array_elements(version.payload->'categories') AS category
  CROSS JOIN LATERAL jsonb_array_elements(category->'aliases') AS alias
  WHERE version.domain='expense_catalog' AND version.version=1
), unique_names AS (
  SELECT name, min(code) AS code FROM names GROUP BY name HAVING count(DISTINCT code)=1
), resolved AS (
  SELECT claim.id,
    COALESCE(array_agg(COALESCE(unique_names.code, '') ORDER BY selected.ordinality), ARRAY[]::TEXT[]) AS codes,
    COALESCE(bool_or(unique_names.code IS NULL), FALSE) AS review_required
  FROM reimbursement.claims AS claim
  CROSS JOIN LATERAL unnest(claim.selected_expense_categories) WITH ORDINALITY AS selected(name, ordinality)
  LEFT JOIN unique_names ON unique_names.name=selected.name
  WHERE claim.itemization_mode='ITEMIZED' AND cardinality(claim.selected_expense_category_codes)=0
  GROUP BY claim.id
)
UPDATE reimbursement.claims AS claim
SET selected_expense_category_codes=resolved.codes,
    category_review_required=resolved.review_required
FROM resolved WHERE claim.id=resolved.id;
