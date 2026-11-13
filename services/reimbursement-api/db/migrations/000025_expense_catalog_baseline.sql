INSERT INTO reimbursement.config_versions (domain, version, payload, published_by)
VALUES ('expense_catalog', 1, $catalog$
{
  "categories": [
    {"code":"LOCAL_TRANSPORT","label":"市内交通费","aliases":["打车费","交通费"],"enabled":true,"sortOrder":10},
    {"code":"DINING","label":"餐饮费","aliases":["餐费"],"enabled":true,"sortOrder":20},
    {"code":"LODGING","label":"住宿费","aliases":["酒店住宿费"],"enabled":true,"sortOrder":30},
    {"code":"TRANSPORT","label":"交通费","aliases":["差旅交通费","火车票"],"enabled":true,"sortOrder":40},
    {"code":"OTHER","label":"其他","aliases":[],"enabled":true,"sortOrder":50}
  ],
  "mappings": [
    {"receiptType":"TAXI","categoryCode":"LOCAL_TRANSPORT","purposeTemplate":"市内出行打车费"},
    {"receiptType":"DINING","categoryCode":"DINING","purposeTemplate":"餐饮费用"},
    {"receiptType":"LODGING","categoryCode":"LODGING","purposeTemplate":"住宿费用"},
    {"receiptType":"TRANSPORT","categoryCode":"TRANSPORT","purposeTemplate":"交通出行费用"},
    {"receiptType":"OTHER","categoryCode":"OTHER","purposeTemplate":"其他费用"}
  ]
}
$catalog$::jsonb, 'system:migration')
ON CONFLICT (domain, version) DO NOTHING;

INSERT INTO reimbursement.config_active_versions (domain, version)
VALUES ('expense_catalog', 1)
ON CONFLICT (domain) DO NOTHING;

INSERT INTO reimbursement.config_audit (domain, action, actor_id, version, note)
VALUES ('expense_catalog', 'PUBLISHED', 'system:migration', 1, 'Baseline from existing fixed mappings');
