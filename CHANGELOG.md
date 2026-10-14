# Changelog

## 0.1.0 (unreleased)

- First release: a sandboxed evaluator with expr-eval compatible syntax, built on jsep.
- Functions are callable by name from a registry only; context values that are functions can be neither read nor called.
- Own properties only; `__proto__`, `constructor` and `prototype` refused as names and keys.
- Limits on expression length, nesting depth, array literals and the size of strings and arrays an evaluation builds.
- `if()` evaluates only the chosen branch.
- Errors are `SafeExprError` with a stable `code`.
