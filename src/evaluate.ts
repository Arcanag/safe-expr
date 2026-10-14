import { SafeExprError } from "./errors.js";
import { FORBIDDEN_NAMES, type Node } from "./parse.js";
import type { ExprFunction } from "./functions.js";

export interface Scope {
    functions: ReadonlyMap<string, ExprFunction>;
    constants: ReadonlyMap<string, unknown>;
    context: object;
    maxStringLength: number;
    maxArrayLength: number;
}

/**
 * Reads a name from a host object. The single gate between expressions and
 * JavaScript values, so every rule lives here:
 *
 * - own properties only (never the prototype chain);
 * - never `__proto__`, `constructor` or `prototype`, even as an own key;
 * - never a function: functions are reachable by name through the registry
 *   and in no other way, so a value cannot become a call target.
 */
function readOwn(holder: unknown, key: string | number, what: string): unknown {
    if (holder === null || holder === undefined) {
        throw new SafeExprError("TYPE", `cannot read "${key}" of ${String(holder)}`);
    }
    if (typeof holder !== "object") {
        // Primitives: only a string's length and characters.
        if (typeof holder === "string") {
            if (key === "length") return holder.length;
            if (typeof key === "number") return holder[key];
        }
        return undefined;
    }
    const k = typeof key === "number" ? String(key) : key;
    if (FORBIDDEN_NAMES.has(k)) {
        throw new SafeExprError("FORBIDDEN", `"${k}" is not allowed`);
    }
    if (!Object.prototype.hasOwnProperty.call(holder, k)) return undefined;
    const value = (holder as Record<string, unknown>)[k];
    if (typeof value === "function") {
        throw new SafeExprError("FORBIDDEN", `${what} "${k}" is a function and cannot be used as a value`);
    }
    return value;
}

function checkSize(value: unknown, scope: Scope): unknown {
    if (typeof value === "string" && value.length > scope.maxStringLength) {
        throw new SafeExprError("LIMIT", `a string grew past ${scope.maxStringLength} characters`);
    }
    if (Array.isArray(value) && value.length > scope.maxArrayLength) {
        throw new SafeExprError("LIMIT", `an array grew past ${scope.maxArrayLength} elements`);
    }
    return value;
}

export function evaluateNode(node: Node, scope: Scope): unknown {
    switch (node.type) {
        case "Literal":
            return node.value;

        case "Identifier": {
            const { name } = node;
            // Constants win over the context, as in expr-eval (it folds them in at parse time).
            if (scope.constants.has(name)) return scope.constants.get(name);
            if (Object.prototype.hasOwnProperty.call(scope.context, name)) {
                return readOwn(scope.context, name, "variable");
            }
            if (scope.functions.has(name) || name === "if") {
                throw new SafeExprError("TYPE", `"${name}" is a function; call it as ${name}(...)`);
            }
            throw new SafeExprError("UNDEFINED_VARIABLE", `undefined variable: ${name}`);
        }

        case "Member": {
            const object = evaluateNode(node.object, scope);
            const key = evaluateNode(node.property, scope);
            if (typeof key !== "string" && typeof key !== "number") {
                throw new SafeExprError("TYPE", "a property name must be a string or a number");
            }
            return readOwn(object, key, "property");
        }

        case "Array":
            return checkSize(node.elements.map((e) => evaluateNode(e, scope)), scope);

        case "Conditional":
            return evaluateNode(node.test, scope)
                ? evaluateNode(node.consequent, scope)
                : evaluateNode(node.alternate, scope);

        case "Unary": {
            const a = evaluateNode(node.argument, scope);
            switch (node.operator) {
                case "-": return -(a as number);
                case "+": return Number(a);
                case "not": return !a;
            }
            break;
        }

        case "Binary": {
            // Short-circuit, as expr-eval: the right side of and/or only runs when needed.
            if (node.operator === "and") {
                return Boolean(evaluateNode(node.left, scope)) && Boolean(evaluateNode(node.right, scope));
            }
            if (node.operator === "or") {
                return Boolean(evaluateNode(node.left, scope)) || Boolean(evaluateNode(node.right, scope));
            }
            const a = evaluateNode(node.left, scope) as any;
            const b = evaluateNode(node.right, scope) as any;
            switch (node.operator) {
                case "+": return Number(a) + Number(b);
                case "-": return a - b;
                case "*": return a * b;
                case "/": return a / b;
                case "%": return a % b;
                case "^": return Math.pow(a, b);
                case "||":
                    if (Array.isArray(a) && Array.isArray(b)) return checkSize(a.concat(b), scope);
                    return checkSize(String(a) + String(b), scope);
                case "==": return a === b;
                case "!=": return a !== b;
                case "<": return a < b;
                case ">": return a > b;
                case "<=": return a <= b;
                case ">=": return a >= b;
            }
            break;
        }

        case "Call": {
            // `if` is a special form: only the chosen branch is evaluated.
            if (node.callee === "if") {
                if (node.args.length !== 3) {
                    throw new SafeExprError("TYPE", "if() takes three arguments: if(condition, then, else)");
                }
                return evaluateNode(node.args[0]!, scope)
                    ? evaluateNode(node.args[1]!, scope)
                    : evaluateNode(node.args[2]!, scope);
            }
            const fn = scope.functions.get(node.callee);
            if (!fn) {
                throw new SafeExprError("UNKNOWN_FUNCTION", `unknown function: ${node.callee}`);
            }
            const args = node.args.map((arg) => evaluateNode(arg, scope));
            const result = fn(...args);
            if (typeof result === "function") {
                throw new SafeExprError("FORBIDDEN", `function ${node.callee} returned a function`);
            }
            return checkSize(result, scope);
        }
    }
    throw new SafeExprError("UNSUPPORTED", "unsupported expression");
}
