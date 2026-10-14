import { SafeExprError } from "./errors.js";
import { evaluateNode, type Scope } from "./evaluate.js";
import { DEFAULT_CONSTANTS, DEFAULT_FUNCTIONS, type ExprFunction } from "./functions.js";
import { FORBIDDEN_NAMES, parse, type Node, type ParseLimits } from "./parse.js";

export { SafeExprError, type SafeExprErrorCode } from "./errors.js";
export { DEFAULT_FUNCTIONS, DEFAULT_CONSTANTS, type ExprFunction } from "./functions.js";
export type { Node } from "./parse.js";

export interface SafeExprOptions {
    /**
     * Functions callable by name. Merged over the defaults unless
     * `defaultFunctions` is false. A function here is the ONLY way an
     * expression can run code, so register nothing you would not hand an
     * untrusted user.
     */
    functions?: Record<string, ExprFunction>;
    /** Include DEFAULT_FUNCTIONS. Default true. */
    defaultFunctions?: boolean;
    /** Named values, checked before the context. Merged over PI and E unless `defaultConstants` is false. */
    constants?: Record<string, unknown>;
    /** Include DEFAULT_CONSTANTS. Default true. */
    defaultConstants?: boolean;
    /** Longest accepted expression, in characters. Default 4096. */
    maxLength?: number;
    /** Deepest accepted nesting. Default 64. */
    maxDepth?: number;
    /** Most elements in one array literal. Default 1000. */
    maxArrayLiteral?: number;
    /** Longest string an evaluation may build. Default 100000. */
    maxStringLength?: number;
    /** Longest array an evaluation may build. Default 10000. */
    maxArrayLength?: number;
}

export interface VariablesOptions {
    /** `candidate.name` instead of `candidate`. Only literal member names are followed. */
    withMembers?: boolean;
}

export interface CompiledExpression {
    readonly source: string;
    /** The parsed tree, for tooling. Treat as read-only. */
    readonly ast: Node;
    /** Evaluates against a context. The context's OWN, non-function properties are the variables. */
    evaluate(context?: object): unknown;
    /** Variables the expression reads (not constants, not function names), in first-seen order. */
    variables(options?: VariablesOptions): string[];
    /** Names of the functions the expression calls, in first-seen order. */
    functions(): string[];
}

export interface Evaluator {
    compile(expression: string): CompiledExpression;
    evaluate(expression: string, context?: object): unknown;
    /** `null` when the expression parses, otherwise the error it would throw. */
    check(expression: string): SafeExprError | null;
}

function toMap<V>(defaults: Readonly<Record<string, V>>, useDefaults: boolean, extra: Record<string, V> | undefined, kind: string) {
    const map = new Map<string, V>();
    const add = (source: Readonly<Record<string, V>>) => {
        for (const name of Object.keys(source)) {
            if (FORBIDDEN_NAMES.has(name)) throw new SafeExprError("FORBIDDEN", `a ${kind} cannot be named "${name}"`);
            map.set(name, source[name]!);
        }
    };
    if (useDefaults) add(defaults);
    if (extra) add(extra);
    return map;
}

function collect(ast: Node, constants: ReadonlyMap<string, unknown>, withMembers: boolean) {
    const variables: string[] = [];
    const functions: string[] = [];
    const push = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };

    // `a.b.c` as a path when every step is a literal name; null otherwise.
    const path = (node: Node): string | null => {
        if (node.type === "Identifier") return node.name;
        if (node.type === "Member" && !node.computed && node.property.type === "Literal") {
            const base = path(node.object);
            return base === null ? null : `${base}.${String(node.property.value)}`;
        }
        return null;
    };

    const walk = (node: Node): void => {
        switch (node.type) {
            case "Identifier":
                if (!constants.has(node.name)) push(variables, node.name);
                return;
            case "Member": {
                const p = withMembers ? path(node) : null;
                const root = p?.split(".")[0];
                if (p !== null && p !== undefined && root !== undefined && !constants.has(root)) {
                    push(variables, p);
                    return;
                }
                walk(node.object);
                if (node.computed) walk(node.property);
                return;
            }
            case "Call":
                push(functions, node.callee);
                node.args.forEach(walk);
                return;
            case "Unary": walk(node.argument); return;
            case "Binary": walk(node.left); walk(node.right); return;
            case "Conditional": walk(node.test); walk(node.consequent); walk(node.alternate); return;
            case "Array": node.elements.forEach(walk); return;
            case "Literal": return;
        }
    };
    walk(ast);
    return { variables, functions };
}

export function createEvaluator(options: SafeExprOptions = {}): Evaluator {
    const functions = toMap(DEFAULT_FUNCTIONS, options.defaultFunctions !== false, options.functions, "function");
    const constants = toMap<unknown>(DEFAULT_CONSTANTS, options.defaultConstants !== false, options.constants, "constant");
    const limits: ParseLimits = {
        maxLength: options.maxLength ?? 4096,
        maxDepth: options.maxDepth ?? 64,
        maxArrayLiteral: options.maxArrayLiteral ?? 1000,
    };
    const maxStringLength = options.maxStringLength ?? 100_000;
    const maxArrayLength = options.maxArrayLength ?? 10_000;

    const compile = (expression: string): CompiledExpression => {
        const ast = parse(expression, limits);
        return Object.freeze({
            source: expression,
            ast,
            evaluate(context: object = {}) {
                if (context === null || typeof context !== "object") {
                    throw new SafeExprError("TYPE", "context must be an object");
                }
                const scope: Scope = { functions, constants, context, maxStringLength, maxArrayLength };
                return evaluateNode(ast, scope);
            },
            variables(opts: VariablesOptions = {}) {
                return collect(ast, constants, Boolean(opts.withMembers)).variables;
            },
            functions() {
                return collect(ast, constants, false).functions;
            },
        });
    };

    return Object.freeze({
        compile,
        evaluate: (expression: string, context?: object) => compile(expression).evaluate(context),
        check(expression: string) {
            try {
                compile(expression);
                return null;
            } catch (error) {
                if (error instanceof SafeExprError) return error;
                throw error;
            }
        },
    });
}

let defaultEvaluator: Evaluator | undefined;
const shared = () => (defaultEvaluator ??= createEvaluator());

/** Compiles with the default functions and constants. */
export function compile(expression: string): CompiledExpression {
    return shared().compile(expression);
}

/** Compiles and evaluates once with the default functions and constants. */
export function evaluate(expression: string, context?: object): unknown {
    return shared().evaluate(expression, context);
}
