/**
 * In-memory tracker + transitions.
 * Singleton-ish: one tracker per module load, shared across tick/detection/commands.
 */

import type { PiState, Tracker } from "./types.ts";

let tracker: Tracker = {
	state: "idle",
	enteredStateAt: Date.now(),
	firedCount: 0,
	lastFiredAt: null,
};

type TransitionListener = (next: PiState, prev: PiState) => void;
const listeners = new Set<TransitionListener>();

export function onTransition(fn: TransitionListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** No-op if `next` equals current state. Otherwise resets the tracker. */
export function transitionTo(next: PiState): void {
	const prev = tracker.state;
	if (prev === next) return;
	tracker = {
		state: next,
		enteredStateAt: Date.now(),
		firedCount: 0,
		lastFiredAt: null,
	};
	for (const fn of listeners) {
		try {
			fn(next, prev);
		} catch {}
	}
}

/** Shallow snapshot for /idle status output. */
export function snapshot(): Tracker {
	return { ...tracker };
}

export function getState(): PiState {
	return tracker.state;
}

export function recordFire(now: number): void {
	tracker = {
		...tracker,
		firedCount: tracker.firedCount + 1,
		lastFiredAt: now,
	};
}

/** Clear fire counters without changing the state. Used by `/idle reset`. */
export function resetCounters(): void {
	tracker = { ...tracker, firedCount: 0, lastFiredAt: null };
}
