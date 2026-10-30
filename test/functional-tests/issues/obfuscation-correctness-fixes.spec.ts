import { assert } from 'chai';

import { TInputOptions } from '../../../src/types/options/TInputOptions';

import { NO_ADDITIONAL_NODES_PRESET } from '../../../src/options/presets/NoCustomNodes';

import { JavaScriptObfuscator } from '../../../src/JavaScriptObfuscatorFacade';

/**
 * Behavior-preserving regression tests: each transformation below used to change the runtime
 * behavior of valid input. Every case obfuscates a snippet and asserts the obfuscated code
 * produces the same result the original source does.
 */
describe('Obfuscation correctness fixes', () => {
    const evaluate = (code: string, options: TInputOptions, globals: Record<string, unknown> = {}): unknown => {
        const obfuscatedCode: string = JavaScriptObfuscator.obfuscate(code, {
            ...NO_ADDITIONAL_NODES_PRESET,
            ...options
        }).getObfuscatedCode();

        const globalNames: string[] = Object.keys(globals);
        const globalValues: unknown[] = globalNames.map((name: string) => globals[name]);

        // eslint-disable-next-line no-new-func
        return new Function(...globalNames, obfuscatedCode)(...globalValues);
    };

    describe('`template literal` should preserve `ToString` (string hint) coercion of interpolations', () => {
        it('Variant #1: uses `toString`, not `valueOf`, for an interpolated object', () => {
            const code: string =
                'var obj = { valueOf: function () { return 1; }, toString: function () { return \'x\'; } };' +
                'return `${obj}` + \'|\' + `a${obj}`;';

            assert.strictEqual(evaluate(code, {}), 'x|ax');
        });

        it('Variant #2: passes the `string` hint to `Symbol.toPrimitive`', () => {
            const code: string =
                'var s = { [Symbol.toPrimitive]: function (hint) { return hint === \'string\' ? \'STR\' : \'DEF\'; } };' +
                'return `${s}`;';

            assert.strictEqual(evaluate(code, {}), 'STR');
        });

        it('Variant #3: still concatenates plain interpolations correctly', () => {
            const code: string = 'var a = 2, b = 3; return `sum=${a + b}!`;';

            assert.strictEqual(evaluate(code, {}), 'sum=5!');
        });
    });

    describe('`controlFlowFlattening` should preserve optional-call argument short-circuit', () => {
        const options: TInputOptions = {
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 1
        };

        it('Variant #1: does not evaluate arguments of an optional call on a nullish callee', () => {
            const code: string =
                'function test () {' +
                '  var called = false;' +
                '  function side () { called = true; return 1; }' +
                '  var foo = null;' +
                '  var result = foo?.(side());' +
                '  return result + \'|called=\' + called;' +
                '}' +
                'return test();';

            assert.strictEqual(evaluate(code, options), 'undefined|called=false');
        });

        it('Variant #2: does not throw on a throwing argument of a short-circuited optional call', () => {
            const code: string =
                'function test () {' +
                '  var foo = undefined;' +
                '  var result;' +
                '  try { result = foo?.(missingReference()); } catch (error) { result = \'THREW\'; }' +
                '  return String(result);' +
                '}' +
                'return test();';

            assert.strictEqual(evaluate(code, options), 'undefined');
        });

        it('Variant #3: still flattens a zero-argument optional call safely', () => {
            const code: string =
                'function test () { var foo = null; return String(foo?.()); } return test();';

            assert.strictEqual(evaluate(code, options), 'undefined');
        });
    });

    describe('`transformObjectKeys` should preserve object semantics', () => {
        const options: TInputOptions = { transformObjectKeys: true };

        it('Variant #1: keeps a computed `[\'__proto__\']` key as an own property', () => {
            const code: string =
                'var o = { [\'__proto__\']: 42 };' +
                'return JSON.stringify({ keys: Object.keys(o), own: Object.getOwnPropertyNames(o) });';

            assert.strictEqual(evaluate(code, options), '{"keys":["__proto__"],"own":["__proto__"]}');
        });

        it('Variant #2: preserves property order around a `get` accessor', () => {
            const code: string = 'var o = { a: 1, get b() { return 2; }, c: 3 }; return JSON.stringify(o);';

            assert.strictEqual(evaluate(code, options), '{"a":1,"b":2,"c":3}');
        });
    });

    describe('`mangled` identifier names should not shadow a referenced free identifier', () => {
        it('Variant #1: a local referencing an external global is not renamed onto that global', () => {
            // `c` is a short external global — the exact kind of name the `mangled` generator
            // would otherwise reuse for the local `x`, shadowing the reference.
            const code: string = 'function f () { var x = 1; return x + c; } return f();';

            assert.strictEqual(evaluate(code, { identifierNamesGenerator: 'mangled' }, { c: 30 }), 31);
        });
    });
});
