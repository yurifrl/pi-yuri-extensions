/**
 * Statusline component registry — module-scope self-registration, ConfigStore-style.
 *
 * Component files call registerComponent() at import time; components.ts imports them for side effects.
 * A second component with the same name throws; re-registering the identical object is tolerated so a module
 * re-evaluation never breaks extension load. An unknown name in statusline.order throws at session start
 * (index.ts) so config typos fail loudly instead of silently dropping a segment.
 */
import type { StatuslineComponent } from "./types.ts";

type AnyComponent = StatuslineComponent<any>;

const components = new Map<string, AnyComponent>();

export function registerComponent<C>(component: StatuslineComponent<C>): void {
	const existing = components.get(component.name);
	if (existing) {
		if (existing === (component as AnyComponent)) return;
		throw new Error(`statusline component '${component.name}' registered twice`);
	}
	components.set(component.name, component as AnyComponent);
}

export function getComponent(name: string): AnyComponent | undefined {
	return components.get(name);
}

export function registeredComponentNames(): string[] {
	return [...components.keys()];
}

/** Test-only: drop every registration. */
export function resetComponents(): void {
	components.clear();
}
