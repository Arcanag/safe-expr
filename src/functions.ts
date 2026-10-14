import { SafeExprError } from "./errors.js";

export type ExprFunction = (...args: any[]) => unknown;

/** sqrt(2 * PI), used by the Lanczos sum. */
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

/**
 * Lanczos coefficients for g = 7, n = 9: the standard published set (e.g.
 * Numerical Recipes; Wikipedia, "Lanczos approximation"). About 15
 * significant digits across the positive reals.
 */
const LANCZOS_G = 7;
const LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
];

/**
 * The gamma function. Whole numbers take an exact product, so `fac(n)` is
 * exact wherever a double can hold it; everything else uses the Lanczos sum,
 * with the reflection formula below 1/2. Poles (0, -1, -2, ...) give Infinity.
 */
function gamma(z: number): number {
    if (Number.isNaN(z)) return NaN;
    if (Number.isInteger(z)) {
        if (z <= 0) return Infinity;
        if (z > 171) return Infinity;
        let product = 1;
        for (let k = 2; k < z; k++) product *= k;
        return product;
    }
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
    if (z > 171.62) return Infinity;
    const x = z - 1;
    let sum = LANCZOS[0]!;
    for (let k = 1; k < LANCZOS.length; k++) sum += LANCZOS[k]! / (x + k);
    const t = x + LANCZOS_G + 0.5;
    return SQRT_TWO_PI * Math.pow(t, x + 0.5) * Math.exp(-t) * sum;
}

/** Moves the decimal point of `x` by `places` through its exponent, without a float multiply. */
function shiftDecimal(x: number, places: number): number {
    const [mantissa, exponent = "0"] = String(x).split("e");
    return Number(`${mantissa}e${Number(exponent) + places}`);
}

/**
 * Rounds to `digits` decimal places (negative digits round to tens, hundreds,
 * ...). Shifting through the exponent instead of multiplying keeps 1.005 from
 * becoming 1.00499999 first, so `roundTo(1.005, 2)` is 1.01.
 */
function roundTo(value: unknown, digits?: unknown): number {
    const v = Number(value);
    const d = digits === undefined ? 0 : Number(digits);
    if (!Number.isFinite(v)) return v;
    if (!Number.isInteger(d)) return NaN;
    if (d === 0) return Math.round(v);
    return shiftDecimal(Math.round(shiftDecimal(v, d)), -d);
}

function numbers(name: string, args: unknown[]): number[] {
    const list = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    return list.map((a) => {
        if (Array.isArray(a)) throw new SafeExprError("TYPE", `${name}() takes numbers or one array`);
        return Number(a);
    });
}

const num = (fn: (x: number) => number): ExprFunction => (x: unknown) => fn(Number(x));

/**
 * The default function set: the same names as expr-eval's built-ins, minus the ones that take a
 * function as an argument (`map`, `filter`, `fold`). This grammar has no
 * function values at all — a function can only be called by name — which is
 * what makes "call a function you were handed" impossible by construction.
 *
 * `if` is NOT here: it is a lazy special form in the evaluator, so only the
 * chosen branch runs.
 */
export const DEFAULT_FUNCTIONS: Readonly<Record<string, ExprFunction>> = Object.freeze({
    abs: num(Math.abs),
    acos: num(Math.acos),
    acosh: num(Math.acosh),
    asin: num(Math.asin),
    asinh: num(Math.asinh),
    atan: num(Math.atan),
    atan2: (y: unknown, x: unknown) => Math.atan2(Number(y), Number(x)),
    atanh: num(Math.atanh),
    cbrt: num(Math.cbrt),
    ceil: num(Math.ceil),
    cos: num(Math.cos),
    cosh: num(Math.cosh),
    exp: num(Math.exp),
    expm1: num(Math.expm1),
    fac: (n: unknown) => gamma(Number(n) + 1),
    floor: num(Math.floor),
    gamma: num(gamma),
    hypot: (...args: unknown[]) => Math.hypot(...numbers("hypot", args)),
    pyt: (...args: unknown[]) => Math.hypot(...numbers("pyt", args)),
    indexOf: (target: unknown, s: unknown) => {
        if (Array.isArray(s)) return s.indexOf(target);
        return String(s).indexOf(String(target));
    },
    join: (sep: unknown, list: unknown) => {
        if (!Array.isArray(list)) throw new SafeExprError("TYPE", "join() needs an array as its second argument");
        return list.join(String(sep));
    },
    length: (s: unknown) => (Array.isArray(s) ? s.length : String(s).length),
    lg: num(Math.log10),
    ln: num(Math.log),
    log: num(Math.log),
    log10: num(Math.log10),
    log1p: num(Math.log1p),
    log2: num(Math.log2),
    max: (...args: unknown[]) => Math.max(...numbers("max", args)),
    min: (...args: unknown[]) => Math.min(...numbers("min", args)),
    not: (a: unknown) => !a,
    pow: (a: unknown, b: unknown) => Math.pow(Number(a), Number(b)),
    random: (n: unknown) => Math.random() * (Number(n) || 1),
    round: num(Math.round),
    roundTo,
    sign: num(Math.sign),
    sin: num(Math.sin),
    sinh: num(Math.sinh),
    sqrt: num(Math.sqrt),
    sum: (list: unknown) => {
        if (!Array.isArray(list)) throw new SafeExprError("TYPE", "sum() needs an array");
        return list.reduce((acc: number, x) => acc + Number(x), 0);
    },
    tan: num(Math.tan),
    tanh: num(Math.tanh),
    trunc: num(Math.trunc),
});

/** Names that are values, not calls: `PI * r ^ 2`. */
export const DEFAULT_CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
    PI: Math.PI,
    E: Math.E,
});
