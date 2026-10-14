import { test } from "node:test";
import assert from "node:assert/strict";
import jsep from "jsep";
import { createEvaluator, evaluate, SafeExprError } from "../dist/index.js";

/** Throws a SafeExprError, and never reaches code execution. */
function refused(expression, context = {}, options) {
    const ev = createEvaluator(options);
    assert.throws(() => ev.evaluate(expression, context), (e) => e instanceof SafeExprError, expression);
}

// A naive helper of the kind that turned expr-eval into RCE: it walks the
// prototype chain. Registered on purpose, to show the sandbox does not depend
// on every host function being written carefully.
const naiveGet = (o, k) => o[k];

test("the Function-constructor chains are refused", () => {
    const chains = [
        'get(get(question, "constructor"), "constructor")("return 6*7")()',
        'get(question, "constructor")',
        "question.constructor",
        'question["constructor"]',
        "question.__proto__",
        'question["__proto__"]',
        "question.prototype",
        "__proto__",
        "constructor",
        "prototype",
        'get(__proto__, "constructor")',
        "constructor(1)",
        'question["const" || "ructor"]',
        'question[join("", ["con", "structor"])]',
        'map(get(get(question,"constructor"),"constructor"), ["a"])',
        'fold(get(get(question,"constructor"),"constructor"), "return 6*7", [1])',
    ];
    for (const c of chains) refused(c, { question: {} }, { functions: { get: naiveGet } });
});

test("a host function that leaks Function still cannot be called through", () => {
    // Even if a registered function returns the Function constructor, the
    // result is refused rather than handed back as a value.
    const leaky = () => Function;
    refused("leak()", {}, { functions: { leak: leaky } });
    refused('leak()("return 1")', {}, { functions: { leak: leaky } });
});

test("functions in the context are values that cannot be read or called", () => {
    const evil = () => "PWNED";
    refused("evil()", { evil });
    refused("evil", { evil });
    refused("tools.evil", { tools: { evil } });
    refused("tools.evil(1)", { tools: { evil } });
    refused('tools["evil"](1)', { tools: { evil } });
    refused("arr[0](1)", { arr: [evil] });
});

test("only a bare function name can be called", () => {
    for (const e of ["abs(1)(2)", "a.b()", "a[0]()", "[abs][0](1)", "(1 ? abs : abs)(1)"]) {
        refused(e, { a: { b: 1 } });
    }
});

test("inherited properties are invisible, own keys are readable", () => {
    const proto = { secret: 42 };
    const obj = Object.create(proto);
    obj.own = 1;
    assert.equal(evaluate("o.own", { o: obj }), 1);
    assert.equal(evaluate("o.secret", { o: obj }), undefined);
    assert.equal(evaluate("o.toString", { o: {} }), undefined);
    assert.equal(evaluate("o.hasOwnProperty", { o: {} }), undefined);
    refused("toString", {});
    refused("valueOf", {});
});

test("an own key named like a prototype member is still refused", () => {
    const o = JSON.parse('{"__proto__": {"x": 1}, "constructor": 2}');
    refused('o["__proto__"]', { o });
    refused('o["constructor"]', { o });
});

test("no prototype pollution through evaluation", () => {
    for (const e of ['__proto__.polluted = 1', 'a.__proto__.polluted', 'x = 1', 'f(x) = x']) {
        try { evaluate(e, { a: {} }); } catch { /* expected */ }
    }
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
});

test("grammar outside the sandbox is refused at parse", () => {
    const unsupported = [
        "a && b", "a || b && c", "a & b", "a | b", "a << 1", "a === b", "a ** 2", "~a", "!a",
        "a; b", "a, b", "a?.b", "x = 1", "() => 1", "new Date()", "`x`", "a ?? b",
    ];
    const ev = createEvaluator();
    for (const e of unsupported) {
        const err = ev.check(e);
        assert.ok(err instanceof SafeExprError, `${e} should be refused`);
    }
});

test("`this` and `null` are ordinary variable names, never JavaScript's", () => {
    assert.throws(() => evaluate("this"), (e) => e.code === "UNDEFINED_VARIABLE");
    assert.throws(() => evaluate("this.x"), (e) => e.code === "UNDEFINED_VARIABLE");
    assert.throws(() => evaluate("null"), (e) => e.code === "UNDEFINED_VARIABLE");
    assert.equal(evaluate("this.x", { this: { x: 1 } }), 1);
});

test("size and depth limits", () => {
    const ev = createEvaluator({ maxLength: 50, maxDepth: 10, maxStringLength: 20, maxArrayLiteral: 3, maxArrayLength: 4 });
    assert.equal(ev.check("1 + ".repeat(20) + "1").code, "LIMIT");
    assert.equal(createEvaluator({ maxDepth: 10 }).check("-".repeat(15) + "1").code, "LIMIT");
    assert.equal(ev.check("[1,2,3,4]").code, "LIMIT");
    assert.throws(() => ev.evaluate("s || s || s", { s: "0123456789" }), (e) => e.code === "LIMIT");
    assert.throws(() => ev.evaluate("[1,2,3] || [4,5]"), (e) => e.code === "LIMIT");
});

test("does not change the host's jsep configuration", () => {
    const J = jsep.Jsep;
    const snap = () => JSON.stringify({ b: J.binary_ops, u: J.unary_ops, l: J.literals, r: [...J.right_associative], t: J.this_str, bl: J.max_binop_len, ul: J.max_unop_len });
    const before = snap();
    evaluate("1 and 2 or not 3 ^ 2 || 'x'");
    try { evaluate("a &&"); } catch { /* parse error path restores too */ }
    const after = snap();
    assert.equal(after, before);
    // And the host's jsep still parses its own grammar.
    assert.equal(jsep("a && b").operator, "&&");
});

test("a host's jsep additions do not widen this grammar", () => {
    jsep.addBinaryOp("evil", 1);
    jsep.addUnaryOp("typeof");
    try {
        assert.ok(createEvaluator().check("a evil b") instanceof SafeExprError);
        assert.ok(createEvaluator().check("typeof a") instanceof SafeExprError);
    } finally {
        jsep.removeBinaryOp("evil");
        jsep.removeUnaryOp("typeof");
    }
});

test("registering a forbidden name is refused", () => {
    assert.throws(() => createEvaluator({ functions: { constructor: () => 1 } }), (e) => e.code === "FORBIDDEN");
    assert.throws(() => createEvaluator({ constants: { __proto__x: 1, ["__proto__"]: 1 } }), (e) => e instanceof SafeExprError || e instanceof Error);
});
