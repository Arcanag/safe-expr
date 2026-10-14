# @arcanag/safe-expr

A sandboxed evaluator for formulas that **users** write: report columns, pricing rules, spreadsheet-style fields.

- **expr-eval compatible syntax.** `a > 1 and b < 5`, `if(x, 'yes', 'no')`, `name || '!'`, `roundTo(ctc / 12, 2)`, `2 ^ 3`. Existing expr-eval formulas keep their meaning; a differential test against expr-eval 2.0.2 runs on every build.
- **No route to JavaScript.** Expressions cannot reach `constructor`, `__proto__`, `prototype`, inherited properties, or any function you did not register by name.
- **Small.** One dependency, [jsep](https://github.com/EricSmekens/jsep), used only to parse.

## Why

[expr-eval](https://github.com/silentmatt/expr-eval) is unmaintained and has open advisories with no fix, including [CVE-2025-12735](https://nvd.nist.gov/vuln/detail/CVE-2025-12735) (functions passed to `evaluate` are not restricted) and a code-execution advisory on `toJSFunction()`. The fork that patches the first still lets `map()`, `filter()` and `fold()` call functions the parser never allowed.

This library takes the other route: the grammar has **no function values at all**. A function can only be called by writing its registered name, so there is nothing to smuggle.

## Install

```sh
npm install @arcanag/safe-expr
```

ESM only. Node 20.19 or later (which can also `require()` it).

## Use

```js
import { createEvaluator } from "@arcanag/safe-expr";

const formulas = createEvaluator({
  functions: { monthly: (yearly) => yearly / 12 },
  constants: { VAT: 0.18 },
});

const column = formulas.compile("roundTo(monthly(candidate.ctc) * (1 + VAT), 2)");
column.evaluate({ candidate: { ctc: 1200000 } }); // 118000

column.variables({ withMembers: true }); // ["candidate.ctc"]
column.functions();                      // ["roundTo", "monthly"]

formulas.check("a && b"); // SafeExprError: operator "&&" is not supported: use "and"
```

One-off use with the defaults: `evaluate("1 + 2 * 3")`, `compile(expression)`.

## Grammar

| | |
|---|---|
| Numbers, strings, booleans | `42`, `1.5e3`, `.5`, `'text'`, `"text"`, `true`, `false` |
| Arithmetic | `+` `-` `*` `/` `%` `^` (power, right-associative; `-2^2` is `-4`) |
| Concatenation | `\|\|` joins strings, or two arrays |
| Comparison | `==` `!=` `<` `>` `<=` `>=` (strict: `'1' == 1` is false) |
| Logic | `and`, `or` (short-circuit), `not` |
| Conditional | `test ? a : b`, `if(test, a, b)` (only the chosen branch runs) |
| Members | `a.b`, `a['key with spaces']`, `list[0]`, `text[0]`, `text.length` |
| Arrays | `[1, 2, 3]` |
| Calls | `name(args)`, where `name` is a registered function |

`+` adds numbers (`'1' + '2'` is `3`); use `||` to join text. That matches expr-eval.

Precedence, lowest first: `? :`, `or`, `and`, comparison, `+ - ||`, `* / %`, unary `- + not`, `^`.

Not supported, by design: assignment, statements (`;`), function definitions, `&&` / `!` / `===` and other JavaScript spellings (the error names the right one), bitwise operators, optional chaining, `new`, template strings.

### Default functions

`abs acos acosh asin asinh atan atan2 atanh cbrt ceil cos cosh exp expm1 fac floor gamma hypot pyt indexOf join length lg ln log log10 log1p log2 max min not pow random round roundTo sign sin sinh sqrt sum tan tanh trunc`, plus `if`. Constants: `PI`, `E`.

`min`, `max`, `hypot` take numbers or one array. `roundTo(x, n)` rounds to `n` decimals without the usual floating-point slip (`roundTo(1.005, 2)` is `1.01`).

expr-eval's `map`, `filter` and `fold` are left out on purpose: they take a function as an argument, and this grammar has no function values.

## The security model

1. **Calls go through the registry only.** The callee must be a bare name in the function table. `a.b()`, `f()()`, `list[0]()` and `(cond ? f : g)()` are refused when parsing.
2. **Values are never functions.** Reading a function out of the context (a variable, a property, an array element) is an error, and so is a registered function returning one.
3. **Own properties only.** Inherited properties read as `undefined`; `__proto__`, `constructor` and `prototype` are refused as names and keys, even as own keys.
4. **A closed grammar.** The parsed tree is converted into a fixed set of node types. A jsep plugin or operator your application registers globally cannot widen it, and this library restores jsep's global operator table after every parse, so it does not change how your own jsep code parses.
5. **Limits.** Expression length (4096), nesting depth (64), array literal size (1000), and the length of any string (100000) or array (10000) an evaluation builds. All configurable.

What stays your responsibility: **the functions you register.** A registered function runs with full JavaScript power, so register only what you would hand an untrusted user, and do not register helpers that walk arbitrary keys (`(o, k) => o[k]`) unless they check `Object.hasOwn`. Getters on context objects run when read.

## Errors

Every failure is a `SafeExprError` with a `code`:

| code | meaning |
|---|---|
| `PARSE` | not a valid expression |
| `UNSUPPORTED` | valid syntax this grammar does not allow |
| `FORBIDDEN` | reaches for the object model, or a function used as a value |
| `LIMIT` | too long, too deep, or builds something too large |
| `UNDEFINED_VARIABLE` | a name that is not in the context |
| `UNKNOWN_FUNCTION` | a call to a name that is not registered |
| `TYPE` | wrong arity for `if()`, a non-object context, a property read on `null` |

## Options

```ts
createEvaluator({
  functions?: Record<string, (...args: any[]) => unknown>,
  defaultFunctions?: boolean,   // default true
  constants?: Record<string, unknown>,
  defaultConstants?: boolean,   // default true
  maxLength?: number,           // 4096
  maxDepth?: number,            // 64
  maxArrayLiteral?: number,     // 1000
  maxStringLength?: number,     // 100000
  maxArrayLength?: number,      // 10000
})
```

## Migrating from expr-eval

- `new Parser().evaluate(expr, ctx)` becomes `createEvaluator().evaluate(expr, ctx)`; `parser.parse(expr)` becomes `compile(expr)`.
- `parser.functions.x = fn` becomes `createEvaluator({ functions: { x: fn } })`.
- Functions passed in the context are refused: register them instead.
- Unparenthesised calls (`sqrt 4`), `!` factorial, `x = 1`, `f(x) = ...`, `;`, `map`/`filter`/`fold` and `in` are not supported.
- `if()` no longer evaluates the branch it does not take.

## License

MIT
