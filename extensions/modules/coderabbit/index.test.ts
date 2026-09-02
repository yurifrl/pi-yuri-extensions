import { expect, test } from "bun:test";
import { parseAgentJsonl, formatCounts } from "./index.ts";

const SAMPLE = [
	'{"type":"review_context","base":"main"}',
	'{"type":"finding","severity":"critical","fileName":"a.ts","comment":"boom"}',
	'{"type":"finding","severity":"minor","fileName":"b.ts","codegenInstructions":"tidy"}',
	'{"type":"finding","severity":"minor","fileName":"c.ts"}',
	'{"type":"heartbeat"}',
	'{"type":"complete","findings":3}',
	"not json",
].join("\n");

test("counts findings by severity and ignores non-finding lines", () => {
	const s = parseAgentJsonl(SAMPLE);
	expect(s.total).toBe(3);
	expect(s.counts).toEqual({ critical: 1, minor: 2 });
	expect(s.findings[1].comment).toBe("tidy");
});

test("formatCounts orders by severity and reads empty as no findings", () => {
	expect(formatCounts({ minor: 2, critical: 1 })).toBe("1 critical, 2 minor");
	expect(formatCounts({})).toBe("no findings");
});
