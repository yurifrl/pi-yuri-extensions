/**
 * kube component: `strip` regexes transform the displayed context; non-matching contexts pass through.
 * pi.exec is mocked (no real kubectl); each case awaits the redraw that fires right after start()'s
 * initial refresh stores the value, so renders never race and no wall-clock waits are needed.
 */
import { describe, expect, test } from "bun:test";
import { getComponent } from "../registry.ts";
import type { ComponentHost, StatuslineTheme } from "../types.ts";
import "./kube.ts";

const theme: StatuslineTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	getBgAnsi: () => "",
};

async function rendered(context: string, raw: Record<string, unknown>): Promise<string | undefined> {
	const component = getComponent("kube")!;
	const cfg = component.parseConfig(raw, {} as never);
	let resolveRedraw: () => void = () => {};
	const refreshed = new Promise<void>((resolve) => {
		resolveRedraw = resolve;
	});
	const host: ComponentHost = {
		pi: { exec: async () => ({ code: 0, stdout: `${context}\n` }) } as never,
		ctx: () => ({ cwd: "/tmp" }) as never,
		redraw: resolveRedraw,
		setStatus: () => {},
		aggregate: () => ({ working: false, refreshing: false, attention: false }),
	};
	const stop = component.start(host, cfg);
	try {
		await refreshed;
		return component.render(cfg, theme) || undefined;
	} finally {
		stop();
	}
}

describe("kube component", () => {
	test("parseConfig defaults to no strip patterns and validates the strip array", () => {
		const component = getComponent("kube")!;
		expect(component.parseConfig({}, {} as never).strip).toEqual([]);
		expect(() => component.parseConfig({ strip: ["^ok", 42] }, {} as never)).toThrow("strip must be an array");
		expect(() => component.parseConfig({ strip: ["("] }, {} as never)).toThrow("strip[0]");
	});

	test("full EKS ARN is stripped to the bare cluster name", async () => {
		expect(
			await rendered("arn:aws:eks:us-east-1:492684252576:cluster/EKS-NSX", {
				strip: ["^arn:aws:eks:[^:]+:[0-9]+:cluster/"],
			}),
		).toBe("⎈ EKS-NSX");
	});

	test("talos user@ prefix is stripped; non-matching contexts pass through", async () => {
		expect(await rendered("admin@talos-default-relay", { strip: ["^admin@"] })).toBe("⎈ talos-default-relay");
		expect(await rendered("plain-context", { strip: ["^arn:"] })).toBe("⎈ plain-context");
	});

	test("a context stripped to nothing hides the segment", async () => {
		expect(await rendered("only", { strip: ["^only"] })).toBeUndefined();
	});
});
