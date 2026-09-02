/**
 * Statusline component barrel — importing this file self-registers every built-in component.
 * Add a new segment: create components/<name>.ts calling registerComponent(), then import it here.
 */
import "./components/indicator.ts";
import "./components/context-limit.ts";
import "./components/budget.ts";
import "./components/session-cost.ts";
import "./components/aws.ts";
import "./components/kube.ts";
