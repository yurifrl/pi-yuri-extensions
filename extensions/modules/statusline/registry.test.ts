import { beforeEach, expect, test } from "bun:test";
import { getComponent, registerComponent, registeredComponentNames, resetComponents } from "./registry.ts";
import type { StatuslineComponent, StatuslineTheme } from "./types.ts";

const theme: StatuslineTheme = {
	fg: (color, text) => (color === "error" ? `E(${text})` : text),
};

function fakeComponent(name: string, value = `${name}-value`): StatuslineComponent {
	return {
		name,
		parseConfig(raw) {
			const input = (typeof raw === "object" && raw !== null ? raw : {}) as { enabled?: boolean };
			return { enabled: input.enabled !== false };
		},
		start() {
			return () => {};
		},
		render(_cfg) {
			return value;
		},
	};
}

beforeEach(() => resetComponents());

test("registerComponent stores and getComponent retrieves by name", () => {
	const component = fakeComponent("alpha");
	registerComponent(component);
	expect(getComponent("alpha")).toBe(component);
	expect(registeredComponentNames()).toEqual(["alpha"]);
});

test("registering the same component object twice is a no-op", () => {
	const component = fakeComponent("alpha");
	registerComponent(component);
	registerComponent(component);
	expect(registeredComponentNames()).toEqual(["alpha"]);
});

test("registering two different components under one name throws", () => {
	registerComponent(fakeComponent("alpha"));
	expect(() => registerComponent(fakeComponent("alpha"))).toThrow(/registered twice/);
});

test("getComponent returns undefined for unknown names", () => {
	expect(getComponent("nope")).toBeUndefined();
});

test("component render drives view output through the contract", () => {
	registerComponent(fakeComponent("alpha", "A"));
	registerComponent(fakeComponent("beta", ""));
	registerComponent(fakeComponent("gamma", "C"));
	const row = [getComponent("alpha")!.render(getComponent("alpha")!.parseConfig({}, {} as never), theme), getComponent("beta")!.render({}, theme), getComponent("gamma")!.render({}, theme)].filter(Boolean).join("  ");
	expect(row).toBe("A  C");
	expect(theme.fg("error", row)).toBe("E(A  C)");
});
