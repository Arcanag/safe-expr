import { test } from "node:test";
import assert from "node:assert/strict";
import { Parser } from "expr-eval";
import { createEvaluator } from "../dist/index.js";

/**
 * Differential test: the same expression and context through expr-eval 2.0.2
 * and through this library must give the same value, or both must fail.
 * Intentional differences are listed in KNOWN_DIFFERENCES with the reason.
 */
const ctx = {
    a: 2, b: 3, c: -1.5, s: "abc", n: "42", t: true, f: false, z: 0,
    arr: [1, 2, 3], words: ["x", "y"],
    candidate: { name: "Asha", age: 31, address: { city: "Pune" }, ctc: 1200000 },
    question: { q1: 7, "notional ctc": 900000 },
};

const corpus = [
    // arithmetic and precedence
    "1 + 2 * 3", "(1 + 2) * 3", "10 / 4", "10 % 4", "2 ^ 3", "2 ^ 3 ^ 2", "-2 ^ 2", "2 * -3 ^ 2", "-a", "+n", "- - a",
    "a + b * c", "a - b - c", "a / b / c", "1e3 + .5", "0.1 + 0.2", "1 / 0", "-1 / 0", "0 / 0",
    // + coerces to numbers; || concatenates
    "n + 1", "s + 1", "'1' + '2'", "s || '!'", "s || 1", "1 || 2", "arr || [4]", "words || ['z']",
    // comparison and logic
    "a == 2", "a != 2", "a < b", "a <= 2", "a > b", "b >= 3", "s == 'abc'", "n == 42", "1 < 2 == true",
    "t and f", "t or f", "not t", "not 0", "not 1 == 0", "a > 1 and b < 5", "z or a", "a and z", "not (a == 2) or b != 3",
    "a > 1 ? 'high' : 'low'", "z ? 1 : 2", "a ? b ? 1 : 2 : 3",
    // members and indexes
    "candidate.name", "candidate.address.city", "candidate.missing", "arr[0]", "arr[2]", "arr[5]", "s[1]",
    "candidate.ctc / 12", "round(candidate.ctc / 12)", "candidate.age > 30 and candidate.address.city == 'Pune'",
    // functions
    "abs(c)", "ceil(c)", "floor(c)", "round(2.5)", "round(-2.5)", "trunc(c)", "sign(c)", "sqrt(16)", "cbrt(27)",
    "exp(1)", "ln(10)", "log(10)", "log10(1000)", "lg(100)", "log2(8)", "log1p(1)", "expm1(1)",
    "sin(1)", "cos(1)", "tan(1)", "asin(0.5)", "acos(0.5)", "atan(1)", "sinh(1)", "cosh(1)", "tanh(1)",
    "asinh(1)", "acosh(2)", "atanh(0.5)", "atan2(1, 2)", "pow(2, 10)", "hypot(3, 4)", "pyt(3, 4)",
    "min(3, 1, 2)", "max(3, 1, 2)", "min(arr)", "max(arr)", "fac(5)", "fac(0)", "gamma(5.5)", "gamma(0.5)",
    "roundTo(1.005, 2)", "roundTo(1234.5678, -2)", "roundTo(3.14159, 3)", "roundTo(2.5)", "roundTo(-1.005, 2)", "roundTo(0.000123456, 5)",
    "fac(10)", "fac(20)", "fac(170)", "gamma(1)", "gamma(-0.5)",
    "length(s)", "length(arr)", "length(n)", "indexOf('b', s)", "indexOf(2, arr)", "indexOf('q', s)",
    "join(', ', words)", "join('-', arr)",
    "if(a > 1, 'yes', 'no')", "if(z, 1, 2)", "if(a > 1 and b < 5, 'x' || 'y', roundTo(a / 3, 2))",
    "PI", "E", "2 * PI", "true", "false",
    // failures both must refuse
    "missing", "missing + 1", "candidate.missing.deeper", "nosuchfn(1)", "1 +", "(1", "'unterminated", "",
];

/** Expressions where the two engines differ on purpose. */
const KNOWN_DIFFERENCES = new Map([
    // expr-eval resolves `missing.deeper` on undefined with a TypeError; we raise a SafeExprError. Both fail; only the error type differs.
]);

/**
 * Gamma is our own Lanczos implementation and multiplies factorials in a
 * different order from expr-eval, so these agree to 12 significant digits
 * rather than to the last bit.
 */
const APPROXIMATE = new Set(["gamma(5.5)", "gamma(0.5)", "gamma(-0.5)", "fac(170)"]);
const close = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));

function run(fn) {
    try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error }; }
}

test("same results as expr-eval 2.0.2 across the corpus", () => {
    const ours = createEvaluator();
    const mismatches = [];
    for (const expression of corpus) {
        const theirs = run(() => new Parser().evaluate(expression, structuredClone(ctx)));
        const mine = run(() => ours.evaluate(expression, structuredClone(ctx)));
        if (theirs.ok !== mine.ok) {
            mismatches.push(`${expression}\n    expr-eval: ${theirs.ok ? JSON.stringify(theirs.value) : "throws " + theirs.error.message}\n    safe-expr: ${mine.ok ? JSON.stringify(mine.value) : "throws " + mine.error.message}`);
            continue;
        }
        if (theirs.ok) {
            if (APPROXIMATE.has(expression)) {
                if (!close(mine.value, theirs.value)) mismatches.push(`${expression}\n    expr-eval: ${theirs.value}\n    safe-expr: ${mine.value}`);
                continue;
            }
            try { assert.deepStrictEqual(mine.value, theirs.value); }
            catch { mismatches.push(`${expression}\n    expr-eval: ${JSON.stringify(theirs.value)}\n    safe-expr: ${JSON.stringify(mine.value)}`); }
        }
    }
    const unexpected = mismatches.filter((m) => !KNOWN_DIFFERENCES.has(m.split("\n")[0]));
    assert.equal(unexpected.length, 0, "\n" + unexpected.join("\n"));
});

test("if() only evaluates the chosen branch (expr-eval evaluates both)", () => {
    // Deliberate improvement: an error in the branch not taken does not fail the expression.
    const ours = createEvaluator();
    assert.equal(ours.evaluate("if(a > 1, 'ok', missing)", ctx), "ok");
    assert.throws(() => new Parser().evaluate("if(a > 1, 'ok', missing)", ctx));
});
