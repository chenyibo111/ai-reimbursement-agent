export type PolicySourceLocator = {
  type: "FEISHU_DOCX" | "FEISHU_WIKI";
  token: string;
  canonicalUrl: string;
};

const tokenPattern = /^[A-Za-z0-9]{12,128}$/;

export function parsePolicySourceUrl(value: string): PolicySourceLocator {
  try {
    const url = new URL(value);
    const match = /^\/(docx|wiki)\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (
      url.protocol !== "https:" || !url.hostname.endsWith(".feishu.cn") || url.port || url.username || url.password
      || url.search || url.hash || !match || !tokenPattern.test(match[2]!)
    ) throw new Error("invalid");
    const type = match[1] === "docx" ? "FEISHU_DOCX" : "FEISHU_WIKI";
    return { type, token: match[2]!, canonicalUrl: `https://${url.hostname}/${match[1]}/${match[2]}` };
  } catch {
    throw new Error("不支持的飞书政策来源链接");
  }
}
