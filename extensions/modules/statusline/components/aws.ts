/**
 * aws component — active AWS profile from environment variables.
 *
 * Checked per frame from process.env (no I/O); first configured variable holding a non-empty value wins.
 * Missing value hides the segment. Env-var list is configurable.
 */
import type { StatuslineComponent, StatuslineTheme } from "../types.ts";
import { color } from "../types.ts";
import { registerComponent } from "../registry.ts";

type StatuslineColor = Parameters<StatuslineTheme["fg"]>[0];

export interface AwsConfig {
	enabled: boolean;
	color: StatuslineColor;
	envVars: string[];
}

const DEFAULT_ENV_VARS = ["AWS_VAULT", "AWS_PROFILE", "AWS_DEFAULT_PROFILE"];

const component: StatuslineComponent<AwsConfig> = {
	name: "aws",
	parseConfig(raw) {
		const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<AwsConfig>;
		const envVars = input.envVars ?? DEFAULT_ENV_VARS;
		if (!Array.isArray(envVars) || envVars.length === 0 || !envVars.every((name) => typeof name === "string" && name.length > 0))
			throw new Error("statusline.components.aws.envVars must be a non-empty array of variable names");
		return { enabled: input.enabled !== false, color: color(input.color, "warning"), envVars };
	},
	start(_host, _cfg) {
		return () => {};
	},
	render(cfg, theme) {
		const profile = cfg.envVars.map((name) => process.env[name]).find((value) => value !== undefined && value !== "");
		if (!profile) return "";
		return theme.fg(cfg.color, `☁ ${profile}`);
	},
};

registerComponent(component);
