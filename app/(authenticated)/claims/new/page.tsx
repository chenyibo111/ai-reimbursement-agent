"use client";

import { useRef, useState } from "react";
import Link from "next/link";

import styles from "./page.module.css";

export default function NewClaimPage() {
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  async function createClaim(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsCreating(true);

    try {
      const response = await fetch("/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: purpose.trim() || undefined }),
      });
      const payload = await response.json() as { id?: string; error?: string };
      if (!response.ok || !payload.id) throw new Error(payload.error || "暂时无法创建报销草稿，请稍后重试。");
      window.location.assign(`/claims/${payload.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法创建报销草稿，请稍后重试。");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="AI 报销首页">AI 报销 <span>Agent</span></Link>
        <span className={styles.secure}>飞书身份已验证</span>
      </header>
      <section className={styles.layout} aria-labelledby="new-claim-title">
        <aside className={styles.rail} aria-label="报销处理步骤">
          <p className={styles.eyebrow}>新的报销卷宗</p>
          <ol>
            <li className={styles.current}><span>1</span>建立草稿</li>
            <li><span>2</span>上传票据</li>
            <li><span>3</span>补齐信息</li>
            <li><span>4</span>确认提交</li>
          </ol>
          <p className={styles.railNote}>系统只会在你确认后提交报销单。</p>
        </aside>
        <section className={styles.panel}>
          <p className={styles.eyebrow}>开始报销</p>
          <h1 id="new-claim-title">发起报销</h1>
          <p className={styles.lede}>先建立一份草稿。票据可以随后逐张上传，AI 会只追问完成提交所需的信息。</p>
          <form className={styles.form} noValidate onSubmit={createClaim}>
            <label htmlFor="purpose">报销事由 <span>可稍后补充</span></label>
            <textarea id="purpose" name="purpose" className="resize-none" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="例如：客户拜访交通与餐饮" rows={4} />
            {error ? <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p> : null}
            <button className={styles.primary} type="submit" disabled={isCreating} aria-busy={isCreating}>{isCreating ? "正在创建…" : "创建报销草稿"}</button>
          </form>
        </section>
      </section>
    </main>
  );
}
