/**
 * Every failure the library raises is a SafeExprError with a stable `code`,
 * so callers can tell "the user typed something invalid" from "the user tried
 * to leave the sandbox" without matching on message text.
 */
export type SafeExprErrorCode =
    /** The text is not a valid expression. */
    | "PARSE"
    /** Valid syntax the grammar deliberately does not allow (assignment, `this`, `&&`, ...). */
    | "UNSUPPORTED"
    /** A name or property that reaches the JavaScript object model (`constructor`, `__proto__`, `prototype`). */
    | "FORBIDDEN"
    /** The expression is too long, too deep or builds something too large. */
    | "LIMIT"
    /** A variable that is not in the context. */
    | "UNDEFINED_VARIABLE"
    /** A call to a name that is not a registered function. */
    | "UNKNOWN_FUNCTION"
    /** An operation applied to a value it cannot work on. */
    | "TYPE";

export class SafeExprError extends Error {
    readonly code: SafeExprErrorCode;
    /** Character offset in the expression, when the parser knows it. */
    readonly index: number | undefined;

    constructor(code: SafeExprErrorCode, message: string, index?: number) {
        super(message);
        this.name = "SafeExprError";
        this.code = code;
        this.index = index;
    }
}
