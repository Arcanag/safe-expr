import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, createEvaluator, evaluate, SafeExprError, DEFAULT_FUNCTIONS } from "../dist/index.js";

test("compile once, evaluate many", () => {
    const expr = compile("price * qty");
    assert.equal(expr.evaluate({ price: 2, qty: 3 }), 6);
    assert.equal(expr.evaluate({ price: 5, qty: 1 }), 5);
    assert.equal(expr.source, "price * qty");
    assert.ok(Object.isFrozen(expr));
});

test("variables() and functions() introspect the expression", () => {
    const expr = compile("if(candidate.age > 30, round(ctc / 12), get(question, 'q1')) + PI + arr[i]");
    assert.deepEqual(expr.variables(), ["candidate", "ctc", "question", "arr", "i"]);
    assert.deepEqual(expr.variables({ withMembers: true }), ["candidate.age", "ctc", "question", "arr", "i"]);
    assert.deepEqual(expr.functions(), ["if", "round", "get"]);
});

test("custom functions and constants", () => {
    const ev = createEvaluator({
        functions: { double: (x) => x * 2 },
        constants: { HALF: 0.5 },
    });
    assert.equal(ev.evaluate("double(10) * (1 + HALF)"), 30);
    assert.equal(ev.evaluate("abs(-1)"), 1);
});

test("defaults can be switched off", () => {
    const ev = createEvaluator({ defaultFunctions: false, defaultConstants: false, functions: { one: () => 1 } });
    assert.equal(ev.evaluate("one()"), 1);
    assert.throws(() => ev.evaluate("abs(-1)"), (e) => e.code === "UNKNOWN_FUNCTION");
    assert.throws(() => ev.evaluate("PI"), (e) => e.code === "UNDEFINED_VARIABLE");
});

test("errors carry a stable code", () => {
    const codes = {
        "1 +": "PARSE",
        "a && b": "UNSUPPORTED",
        "x.constructor": "FORBIDDEN",
        "missing": "UNDEFINED_VARIABLE",
        "nope(1)": "UNKNOWN_FUNCTION",
        "if(1, 2)": "TYPE",
    };
    for (const [expression, code] of Object.entries(codes)) {
        assert.throws(() => evaluate(expression, { x: {} }), (e) => e instanceof SafeExprError && e.code === code, expression);
    }
});

test("JavaScript operators get a hint naming the right spelling", () => {
    const ev = createEvaluator();
    assert.match(ev.check("a && b").message, /use "and"/);
    assert.match(ev.check("!a").message, /use "not"/);
    assert.match(ev.check("a === b").message, /use "=="/);
    assert.match(ev.check("a ** 2").message, /use "\^"/);
});

test("check() returns null or the error, without throwing", () => {
    const ev = createEvaluator();
    assert.equal(ev.check("1 + 2"), null);
    assert.equal(ev.check("1 +").code, "PARSE");
});

test("calling a function name without parentheses is a clear error", () => {
    assert.throws(() => evaluate("abs"), (e) => e.code === "TYPE" && /call it as abs/.test(e.message));
});

test("the default function table is frozen", () => {
    assert.ok(Object.isFrozen(DEFAULT_FUNCTIONS));
});

test("a context that is not an object is refused", () => {
    assert.throws(() => compile("1").evaluate(5), (e) => e.code === "TYPE");
});
