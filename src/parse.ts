import jsep from "jsep";
import { SafeExprError } from "./errors.js";

/**
 * The parsed form. A closed set of node types: anything jsep (or a jsep plugin
 * the host registered globally) produces outside this set is rejected, so the
 * grammar can never widen behind our back.
 */
export type Node =
    | { type: "Literal"; value: string | number | boolean }
    | { type: "Identifier"; name: string }
    | { type: "Member"; object: Node; property: Node; computed: boolean }
    | { type: "Call"; callee: string; args: Node[] }
    | { type: "Unary"; operator: UnaryOperator; argument: Node }
    | { type: "Binary"; operator: BinaryOperator; left: Node; right: Node }
    | { type: "Conditional"; test: Node; consequent: Node; alternate: Node }
    | { type: "Array"; elements: Node[] };

export type UnaryOperator = "-" | "+" | "not";
export type BinaryOperator =
    | "+" | "-" | "*" | "/" | "%" | "^" | "||"
    | "==" | "!=" | "<" | ">" | "<=" | ">="
    | "and" | "or";

/**
 * Property and variable names that reach the JavaScript object model. Rejected
 * wherever they appear as a name, whatever the context object holds.
 */
export const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export interface ParseLimits {
    /** Longest accepted expression, in characters. */
    maxLength: number;
    /** Deepest accepted nesting of the parsed tree. */
    maxDepth: number;
    /** Most elements in one array literal. */
    maxArrayLiteral: number;
}

/**
 * Operator table, laid out to match expr-eval's precedence so existing
 * expressions keep their meaning:
 *
 *   or < and < comparison (all one level) < + - || < * / % < unary < ^
 *
 * `||` is string/array concatenation, not logical OR, and sits with `+`.
 * Unary minus binding looser than `^` (`-2^2` is -4) is applied after parsing,
 * in `liftUnaryOverPower`, because jsep binds every prefix operator tightest.
 */
const BINARY_OPS: Record<string, number> = {
    or: 1,
    and: 2,
    "==": 3, "!=": 3, "<": 3, ">": 3, "<=": 3, ">=": 3,
    "+": 4, "-": 4, "||": 4,
    "*": 5, "/": 5, "%": 5,
    "^": 6,
};
const RIGHT_ASSOCIATIVE = new Set(["^"]);
const UNARY_OPS: Record<string, number> = { "-": 1, "+": 1, not: 1 };

/**
 * JavaScript operators people type out of habit. They are parsed only so the
 * error can name the right spelling; `convert` refuses every one of them.
 */
const JS_BINARY_HINTS: Record<string, { prec: number; hint: string }> = {
    "&&": { prec: 2, hint: 'use "and"' },
    "===": { prec: 3, hint: 'use "=="' },
    "!==": { prec: 3, hint: 'use "!="' },
    "**": { prec: 6, hint: 'use "^"' },
    "??": { prec: 1, hint: 'use if() or "? :"' },
    "&": { prec: 2, hint: "bitwise operators are not supported" },
    "|": { prec: 1, hint: "bitwise operators are not supported" },
    "<<": { prec: 4, hint: "bitwise operators are not supported" },
    ">>": { prec: 4, hint: "bitwise operators are not supported" },
    ">>>": { prec: 4, hint: "bitwise operators are not supported" },
};
const JS_UNARY_HINTS: Record<string, string> = {
    "!": 'use "not"',
    "~": "bitwise operators are not supported",
};
const LITERALS: Record<string, boolean> = { true: true, false: false };

type JsepStatics = {
    binary_ops: Record<string, number>;
    unary_ops: Record<string, number>;
    right_associative: Set<string>;
    literals: Record<string, unknown>;
    this_str: string;
    max_binop_len: number;
    max_unop_len: number;
    getMaxKeyLen(obj: object): number;
};

/**
 * jsep keeps its operator table in global statics. Installing ours for the
 * duration of one synchronous parse, then restoring whatever was there, keeps
 * this library from changing how the host's own jsep usage parses (and keeps a
 * host's jsep configuration from changing ours).
 */
function withOurGrammar<T>(fn: () => T): T {
    // The statics live on the Jsep class; the default export only holds copies
    // made at load time, so assigning to it would change nothing the parser reads.
    const j = (jsep as unknown as { Jsep: JsepStatics }).Jsep;
    const saved = {
        binary_ops: j.binary_ops,
        unary_ops: j.unary_ops,
        right_associative: j.right_associative,
        literals: j.literals,
        this_str: j.this_str,
        max_binop_len: j.max_binop_len,
        max_unop_len: j.max_unop_len,
    };
    try {
        j.binary_ops = { ...BINARY_OPS };
        for (const [op, { prec }] of Object.entries(JS_BINARY_HINTS)) j.binary_ops[op] = prec;
        j.unary_ops = { ...UNARY_OPS };
        for (const op of Object.keys(JS_UNARY_HINTS)) j.unary_ops[op] = 1;
        j.right_associative = new Set(RIGHT_ASSOCIATIVE);
        j.literals = { ...LITERALS };
        // No `this`: a string no identifier can equal.
        j.this_str = "\u0000";
        j.max_binop_len = j.getMaxKeyLen(j.binary_ops);
        j.max_unop_len = j.getMaxKeyLen(j.unary_ops);
        return fn();
    } finally {
        Object.assign(j, saved);
    }
}

export function parse(expression: string, limits: ParseLimits): Node {
    if (typeof expression !== "string") {
        throw new SafeExprError("TYPE", "expression must be a string");
    }
    if (expression.length > limits.maxLength) {
        throw new SafeExprError("LIMIT", `expression is longer than ${limits.maxLength} characters`);
    }
    if (expression.trim() === "") {
        throw new SafeExprError("PARSE", "expression is empty");
    }

    let raw: unknown;
    try {
        raw = withOurGrammar(() => jsep(expression));
    } catch (error) {
        const e = error as { message?: string; index?: number };
        throw new SafeExprError("PARSE", e.message ?? "invalid expression", e.index);
    }
    return liftUnaryOverPower(convert(raw, 0, limits));
}

function convert(raw: unknown, depth: number, limits: ParseLimits): Node {
    if (depth > limits.maxDepth) {
        throw new SafeExprError("LIMIT", `expression is nested deeper than ${limits.maxDepth} levels`);
    }
    const n = raw as Record<string, unknown> & { type: string };
    const next = (child: unknown) => convert(child, depth + 1, limits);

    switch (n.type) {
        case "Literal": {
            const value = n.value;
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                return { type: "Literal", value };
            }
            // jsep turns `null` and regex-like input into other literal kinds.
            throw new SafeExprError("UNSUPPORTED", `unsupported literal ${String(n.raw ?? value)}`);
        }
        case "Identifier": {
            const name = n.name as string;
            if (FORBIDDEN_NAMES.has(name)) {
                throw new SafeExprError("FORBIDDEN", `"${name}" is not allowed`);
            }
            return { type: "Identifier", name };
        }
        case "MemberExpression": {
            const computed = Boolean(n.computed);
            const property = computed
                ? next(n.property)
                : { type: "Literal" as const, value: (n.property as { name: string }).name };
            if (property.type === "Literal" && typeof property.value === "string" && FORBIDDEN_NAMES.has(property.value)) {
                throw new SafeExprError("FORBIDDEN", `"${property.value}" is not allowed`);
            }
            if (n.optional) {
                throw new SafeExprError("UNSUPPORTED", "optional chaining is not supported");
            }
            return { type: "Member", object: next(n.object), property, computed };
        }
        case "CallExpression": {
            const callee = n.callee as { type: string; name?: string };
            // Only a bare name can be called. `a.b()`, `f()()`, `(x)()` and
            // `arr[0]()` are all refused here, so a function can never be
            // reached through data, only through the registry.
            if (callee.type !== "Identifier" || typeof callee.name !== "string") {
                throw new SafeExprError("UNSUPPORTED", "only a function name can be called");
            }
            if (FORBIDDEN_NAMES.has(callee.name)) {
                throw new SafeExprError("FORBIDDEN", `"${callee.name}" is not allowed`);
            }
            const args = (n.arguments as unknown[]).map(next);
            return { type: "Call", callee: callee.name, args };
        }
        case "UnaryExpression": {
            const operator = n.operator as string;
            if (!Object.hasOwn(UNARY_OPS, operator)) {
                const hint = Object.hasOwn(JS_UNARY_HINTS, operator) ? `: ${JS_UNARY_HINTS[operator]}` : "";
                throw new SafeExprError("UNSUPPORTED", `operator "${operator}" is not supported${hint}`);
            }
            return { type: "Unary", operator: operator as UnaryOperator, argument: next(n.argument) };
        }
        case "BinaryExpression": {
            const operator = n.operator as string;
            if (!Object.hasOwn(BINARY_OPS, operator)) {
                const hint = Object.hasOwn(JS_BINARY_HINTS, operator) ? `: ${JS_BINARY_HINTS[operator]!.hint}` : "";
                throw new SafeExprError("UNSUPPORTED", `operator "${operator}" is not supported${hint}`);
            }
            return { type: "Binary", operator: operator as BinaryOperator, left: next(n.left), right: next(n.right) };
        }
        case "ConditionalExpression":
            return { type: "Conditional", test: next(n.test), consequent: next(n.consequent), alternate: next(n.alternate) };
        case "ArrayExpression": {
            const elements = n.elements as unknown[];
            if (elements.length > limits.maxArrayLiteral) {
                throw new SafeExprError("LIMIT", `array literal has more than ${limits.maxArrayLiteral} elements`);
            }
            if (elements.some((e) => e === null)) {
                throw new SafeExprError("PARSE", "array literal has an empty slot");
            }
            return { type: "Array", elements: elements.map(next) };
        }
        case "Compound":
            throw new SafeExprError("UNSUPPORTED", "only one expression is allowed");
        case "ThisExpression":
            throw new SafeExprError("UNSUPPORTED", "`this` is not supported");
        default:
            throw new SafeExprError("UNSUPPORTED", `${n.type} is not supported`);
    }
}

/**
 * jsep parses `-2^2` as `(-2)^2`; expr-eval (and maths) read it as `-(2^2)`.
 * Rewrites every `Binary(^)` whose left side is a prefix operator so the
 * operator applies to the power instead. Bottom-up, so `-a^-b^c` settles too.
 */
function liftUnaryOverPower(node: Node): Node {
    switch (node.type) {
        case "Binary": {
            const left = liftUnaryOverPower(node.left);
            const right = liftUnaryOverPower(node.right);
            if (node.operator === "^" && left.type === "Unary") {
                return {
                    type: "Unary",
                    operator: left.operator,
                    argument: liftUnaryOverPower({ type: "Binary", operator: "^", left: left.argument, right }),
                };
            }
            return { ...node, left, right };
        }
        case "Unary":
            return { ...node, argument: liftUnaryOverPower(node.argument) };
        case "Member":
            return { ...node, object: liftUnaryOverPower(node.object), property: liftUnaryOverPower(node.property) };
        case "Call":
            return { ...node, args: node.args.map(liftUnaryOverPower) };
        case "Conditional":
            return {
                ...node,
                test: liftUnaryOverPower(node.test),
                consequent: liftUnaryOverPower(node.consequent),
                alternate: liftUnaryOverPower(node.alternate),
            };
        case "Array":
            return { ...node, elements: node.elements.map(liftUnaryOverPower) };
        default:
            return node;
    }
}
