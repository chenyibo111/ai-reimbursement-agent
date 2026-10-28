import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import type { ClaimSearchQuery, ClaimStatus } from "../api/generated/reimbursement";
import { useClaims } from "../features/claims/use-claim";
import { claimAmountSummary } from "../features/claims/claim-display";

const statusLabel: Record<ClaimStatus, string> = {
  DRAFT: "草稿",
  PROCESSING: "处理中",
  NEEDS_INFORMATION: "待补充",
  AWAITING_CONFIRMATION: "待确认",
  SUBMITTED: "已提交",
};

type Filters = { status: "" | "DRAFT" | "SUBMITTED"; purposeContains: string; expenseCategory: string; createdFrom: string; createdBefore: string; minAmount: string; maxAmount: string; sort: NonNullable<ClaimSearchQuery["sort"]> };
const emptyFilters: Filters = { status: "", purposeContains: "", expenseCategory: "", createdFrom: "", createdBefore: "", minAmount: "", maxAmount: "", sort: "created_desc" };
const sorts = new Set<Filters["sort"]>(["created_desc", "created_asc", "amount_desc", "amount_asc"]);

function readFilters(params: URLSearchParams): Filters {
  const status = params.get("status");
  const sort = params.get("sort") as Filters["sort"] | null;
  return {
    status: status === "DRAFT" || status === "SUBMITTED" ? status : "",
    purposeContains: params.get("purposeContains") ?? "", expenseCategory: params.get("expenseCategory") ?? "",
    createdFrom: params.get("createdFrom") ?? "", createdBefore: params.get("createdBefore") ?? "",
    minAmount: params.get("minAmount") ?? "", maxAmount: params.get("maxAmount") ?? "",
    sort: sort && sorts.has(sort) ? sort : "created_desc",
  };
}

function amountInCent(value: string): number | null {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) return null;
  const [yuan, fraction = ""] = value.split(".");
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
}

function toQuery(filters: Filters, page: number): Omit<ClaimSearchQuery, "cursor"> {
  return {
    limit: 10, page, sort: filters.sort,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.purposeContains.trim() ? { purposeContains: filters.purposeContains.trim() } : {}),
    ...(filters.expenseCategory.trim() ? { expenseCategory: filters.expenseCategory.trim() } : {}),
    ...(filters.createdFrom ? { createdFrom: filters.createdFrom } : {}),
    ...(filters.createdBefore ? { createdBefore: filters.createdBefore } : {}),
    ...(filters.minAmount ? { minRequestedAmountCent: amountInCent(filters.minAmount)! } : {}),
    ...(filters.maxAmount ? { maxRequestedAmountCent: amountInCent(filters.maxAmount)! } : {}),
  };
}

function readPage(params: URLSearchParams): number {
  const raw = params.get("page");
  if (!raw || !/^[1-9]\d{0,4}$/.test(raw)) return 1;
  const page = Number(raw);
  return page <= 10000 ? page : 1;
}

function visiblePages(page: number, totalPages: number): Array<number | "…"> {
  const pages = new Set([1, 2, page - 1, page, page + 1, totalPages - 1, totalPages]);
  const valid = [...pages].filter((value) => value >= 1 && value <= totalPages).sort((a, b) => a - b);
  return valid.flatMap((value, index) => index && value > valid[index - 1] + 1 ? ["…" as const, value] : [value]);
}

function toParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["status", "purposeContains", "expenseCategory", "createdFrom", "createdBefore", "minAmount", "maxAmount"] as const) {
    if (filters[key].trim()) params.set(key, filters[key].trim());
  }
  if (filters.sort !== "created_desc") params.set("sort", filters.sort);
  return params;
}

export function ClaimListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const filterKey = toParams(readFilters(searchParams)).toString();
  const [draft, setDraft] = useState<Filters>(() => readFilters(searchParams));
  const [filterError, setFilterError] = useState<string | null>(null);
  const [jumpInput, setJumpInput] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);
  useEffect(() => { setDraft(readFilters(new URLSearchParams(filterKey))); setFilterError(null); }, [filterKey]);
  const page = readPage(searchParams);
  const claimsQuery = useClaims(toQuery(readFilters(searchParams), page));
  const items = claimsQuery.data?.items ?? [];
  const total = claimsQuery.data?.totalCount;
  const totalPages = Math.max(1, Math.min(10000, Math.ceil((total ?? 0) / 10)));

  useEffect(() => {
    const raw = searchParams.get("page");
    if (raw !== null && (readPage(searchParams) === 1 && raw !== "1")) {
      const next = new URLSearchParams(searchParams);
      next.delete("page");
      setSearchParams(next, { replace: true });
    }
  }, [searchKey, searchParams, setSearchParams]);

  useEffect(() => {
    if (total !== undefined && page > totalPages) {
      const next = new URLSearchParams(searchParams);
      if (totalPages === 1) next.delete("page"); else next.set("page", String(totalPages));
      setSearchParams(next, { replace: true });
    }
  }, [page, total, totalPages, searchKey, searchParams, setSearchParams]);

  function goToPage(nextPage: number) {
    if (nextPage < 1 || nextPage > totalPages || nextPage === page) return;
    setJumpError(null);
    setJumpInput("");
    const next = new URLSearchParams(searchParams);
    if (nextPage === 1) next.delete("page"); else next.set("page", String(nextPage));
    setSearchParams(next);
  }

  function jumpToPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = jumpInput.trim();
    if (!/^[1-9]\d*$/.test(target) || Number(target) > totalPages) {
      setJumpError(`页码需在 1–${totalPages} 之间。`);
      return;
    }
    setJumpError(null);
    if (Number(target) === page) { setJumpInput(""); return; }
    goToPage(Number(target));
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((draft.createdFrom && draft.createdBefore && draft.createdFrom > draft.createdBefore) ||
      (draft.minAmount && amountInCent(draft.minAmount) === null) ||
      (draft.maxAmount && amountInCent(draft.maxAmount) === null) ||
      (draft.minAmount && draft.maxAmount && amountInCent(draft.minAmount)! > amountInCent(draft.maxAmount)!)) {
      setFilterError("请检查日期区间和金额范围；金额最多保留两位小数。");
      return;
    }
    setFilterError(null);
    setSearchParams(toParams(draft));
  }

  return (
    <main className="page-shell" aria-labelledby="claims-page-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">员工报销</p>
          <h1 id="claims-page-title">我的凭证卷宗</h1>
          <p className="page-summary">按状态、时间或金额找到本人单据，继续查看票据与办理进度。</p>
        </div>
        <Link className="primary-action new-claim-action" to="/claims/new">新建报销单</Link>
      </header>

      <section className="claim-list" aria-labelledby="claim-list-title">
        <div className="section-heading">
          <h2 id="claim-list-title">我的报销单</h2>
          {total !== undefined && <span className="quiet-count" role="status">共 {total} 条匹配单据</span>}
        </div>
        <form className="claim-search-form" onSubmit={applyFilters} noValidate aria-label="筛选报销单">
          <label>状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as Filters["status"] })}><option value="">全部</option><option value="DRAFT">草稿</option><option value="SUBMITTED">已提交</option></select></label>
          <label>事由关键词<input value={draft.purposeContains} onChange={(event) => setDraft({ ...draft, purposeContains: event.target.value })} placeholder="例如：客户拜访" maxLength={200} /></label>
          <label>费用类别<input value={draft.expenseCategory} onChange={(event) => setDraft({ ...draft, expenseCategory: event.target.value })} maxLength={100} /></label>
          <label>创建日期起<input type="date" value={draft.createdFrom} onChange={(event) => setDraft({ ...draft, createdFrom: event.target.value })} /></label>
          <label>创建日期止（不含）<input type="date" value={draft.createdBefore} onChange={(event) => setDraft({ ...draft, createdBefore: event.target.value })} /></label>
          <label>申请金额下限（元）<input inputMode="decimal" value={draft.minAmount} onChange={(event) => setDraft({ ...draft, minAmount: event.target.value })} placeholder="0.00" /></label>
          <label>申请金额上限（元）<input inputMode="decimal" value={draft.maxAmount} onChange={(event) => setDraft({ ...draft, maxAmount: event.target.value })} placeholder="0.00" /></label>
          <label>排序<select value={draft.sort} onChange={(event) => setDraft({ ...draft, sort: event.target.value as Filters["sort"] })}><option value="created_desc">创建时间：最新</option><option value="created_asc">创建时间：最早</option><option value="amount_desc">申请金额：从高到低</option><option value="amount_asc">申请金额：从低到高</option></select></label>
          <div className="claim-search-actions"><button className="primary-action" type="submit">筛选单据</button><button className="secondary-action" type="button" onClick={() => { setDraft(emptyFilters); setSearchParams(new URLSearchParams()); setFilterError(null); }}>清除筛选</button></div>
        </form>
        {filterError && <p className="field-error" role="alert">{filterError}</p>}
        {claimsQuery.isPending && <p className="empty-state" role="status">正在读取你的报销单…</p>}
        {claimsQuery.isError && items.length === 0 && <p className="field-error" role="alert">读取报销单失败。请检查连接后重试。 <button className="text-action" type="button" onClick={() => void claimsQuery.refetch()}>重新加载</button></p>}
        {claimsQuery.data && items.length === 0 && page <= totalPages && <p className="empty-state">{filterKey ? "没有符合条件的报销单。可调整条件或清除筛选。" : "尚无报销草稿。创建一份卷宗即可从上传票据开始。"}</p>}
        <div className="claim-grid">
          {items.map((claim) => (
            <Link className="claim-card" key={claim.id} to={`/claims/${claim.id}`}>
              <div className="claim-card-topline">
					<code className="claim-number">{claim.claimNumber}</code>
                <span className={`status-tag status-${claim.status.toLowerCase()}`}>{statusLabel[claim.status]}</span>
              </div>
              <strong>{claim.purpose || "未填写报销事由"}</strong>
				<div className="claim-card-summary">
					<span>{claimAmountSummary(claim.totalAmountCent, claim.missingAmountReceiptCount)}</span>
					<span>票据 {claim.receiptCount} 份，已识别 {claim.recognizedReceiptCount} 份</span>
				</div>
              <span className="card-meta">更新于 <time dateTime={claim.updatedAt}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(claim.updatedAt))}</time> · 版本 {claim.version}</span>
            </Link>
          ))}
        </div>
        {claimsQuery.data && page <= totalPages && <div className="claim-list-footer">
          <span className="quiet-count">{total === 0 ? "共 0 条" : `第 ${(page - 1) * 10 + 1}–${(page - 1) * 10 + items.length} 条 / 共 ${total} 条`}</span>
          {totalPages > 1 && <div className="claim-pagination-controls">
            <nav className="claim-pagination" aria-label="报销单分页">
              <button className="secondary-action" type="button" disabled={page === 1} onClick={() => goToPage(page - 1)}>上一页</button>
              {visiblePages(page, totalPages).map((value, index) => value === "…" ? <span className="pagination-ellipsis" aria-hidden="true" key={`ellipsis-${index}`}>…</span> : <button className="secondary-action pagination-page" type="button" key={value} aria-label={`第 ${value} 页`} aria-current={page === value ? "page" : undefined} onClick={() => goToPage(value)}>{value}</button>)}
              <button className="secondary-action" type="button" disabled={page === totalPages} onClick={() => goToPage(page + 1)}>下一页</button>
            </nav>
            <form className="claim-page-jump" onSubmit={jumpToPage} noValidate>
              <label>跳转页码<input type="number" inputMode="numeric" min="1" max={totalPages} step="1" value={jumpInput} onChange={(event) => setJumpInput(event.target.value)} /></label>
              <button className="secondary-action" type="submit">跳转</button>
              {jumpError && <span className="field-error" role="alert">{jumpError}</span>}
            </form>
          </div>}
        </div>}
      </section>
    </main>
  );
}
