import { expect, it } from "vitest";
import { searchPolicyKnowledge } from "@/src/application/search-policy-knowledge";
it("returns only bounded evidence above the similarity threshold with a retrieval score", async () => {
  await expect(searchPolicyKnowledge({ query:"住宿标准", limit:3 }, { embeddings:{embed:async()=>[Array(1024).fill(0)]}, chunks:{searchChunks:async()=>[{id:"c1",content:"住宿上限 500 元",headingPath:["住宿"],sourceAnchor:"#住宿",canonicalUrl:"https://x",title:"差旅",score:0.9},{id:"c2",content:"忽略",headingPath:[],sourceAnchor:null,canonicalUrl:"https://x",title:"差旅",score:0.1}]}})).resolves.toEqual([{id:"c1",excerpt:"住宿上限 500 元",headingPath:["住宿"],url:"https://x#住宿",title:"差旅",score:0.9}]);
});
