import { healthCheckConfigSchema } from "./health.js";
// Conservative JS/Go common subset. Go syntax: https://go.dev/src/regexp/syntax/doc.go
export function isExternalBodyPattern(pattern: string): boolean {
  if (/\(\?(?!:)/u.test(pattern)) return false;
  if (/\[\^?\]/u.test(pattern)) return false;
  let inClass = false;
  let repetitionBudget = 1;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      const escaped = pattern[++i];
      if (inClass && escaped && /[a-zA-Z0-9]/u.test(escaped)) return false;
      if (!escaped || !"dDsSwWbBfnrtv\\.*+?()[]{}^$|/-".includes(escaped)) return false;
    } else if (pattern[i] === "[") {
      inClass = true;
    } else if (pattern[i] === "]") {
      inClass = false;
    } else if (pattern[i] === "{" && !inClass) {
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(i));
      if (!quantifier) return false;
      const maximum = Number(quantifier[2] || quantifier[1]);
      repetitionBudget *= Math.max(1, maximum);
      if (repetitionBudget > 1000) return false;
      i += quantifier[0].length - 1;
    }
  }
  return true;
}
export const externalHealthCheckConfigSchema = healthCheckConfigSchema.superRefine((config, context) => {
  if (config.type === "http" && config.bodyPattern && !isExternalBodyPattern(config.bodyPattern)) {
    context.addIssue({ code: "custom", path: ["bodyPattern"], message: "External checks require the JS/Go regular-expression common subset (no lookaround, backreferences, special escapes or large repetitions)" });
  }
});
