'use strict';

const assert = require('node:assert');
const { encodeValue, decodeValue, valueTypeOf, sameValue } = require('../../build/lib/values');
const { PatternList, patternToRegExp } = require('../../build/lib/patterns');
const { classifySource } = require('../../build/lib/source');
const { SourceKind } = require('../../build/lib/types');

describe('values', () => {
    it('maps common.type to the encoding', () => {
        assert.strictEqual(valueTypeOf('boolean'), 'boolean');
        assert.strictEqual(valueTypeOf('number'), 'number');
        assert.strictEqual(valueTypeOf('string'), 'string');
        assert.strictEqual(valueTypeOf('mixed'), 'json');
        assert.strictEqual(valueTypeOf(undefined), 'json');
    });

    it('round-trips every type', () => {
        const cases = [
            [true, 'boolean'],
            [false, 'boolean'],
            [21.5, 'number'],
            [0, 'number'],
            ['hello', 'string'],
            ['', 'string'],
            [null, 'number'],
            ['[1,2]', 'json'],
            [5, 'json'],
            ['text', 'json'],
        ];
        for (const [value, type] of cases) {
            assert.deepStrictEqual(decodeValue(encodeValue(value, type), type), value, `${JSON.stringify(value)} as ${type}`);
        }
    });

    it('keeps values that do not fit their type as text', () => {
        assert.deepStrictEqual(encodeValue('on', 'boolean'), { val: null, sval: 'on' });
        assert.deepStrictEqual(encodeValue('abc', 'number'), { val: null, sval: 'abc' });
        assert.deepStrictEqual(encodeValue('12.5', 'number'), { val: 12.5, sval: null });
        assert.deepStrictEqual(encodeValue('true', 'boolean'), { val: 1, sval: null });
    });

    it('compares stored values', () => {
        assert.ok(sameValue({ val: 1, sval: null }, { val: 1, sval: null }));
        assert.ok(!sameValue({ val: 1, sval: null }, { val: 0, sval: null }));
        assert.ok(!sameValue({ val: null, sval: '1' }, { val: 1, sval: null }));
    });
});

describe('patterns', () => {
    it('matches wildcards and escapes dots', () => {
        const r = patternToRegExp('zigbee.0.*.state');
        assert.ok(r.test('zigbee.0.abc.state'));
        assert.ok(!r.test('zigbee.0.abc.stateX'));
        assert.ok(!patternToRegExp('a.b').test('aXb'));
    });

    it('ignores empty patterns', () => {
        const list = new PatternList(['', '  ', 'system.*']);
        assert.ok(list.matches('system.adapter.admin.0.alive'));
        assert.ok(!list.matches('hm-rpc.0.x'));
        assert.ok(new PatternList([]).isEmpty);
    });
});

describe('source', () => {
    it('classifies state.from', () => {
        assert.strictEqual(classifySource('system.adapter.vis-2.0'), SourceKind.User);
        assert.strictEqual(classifySource('system.adapter.admin.0'), SourceKind.User);
        assert.strictEqual(classifySource('system.adapter.javascript.0'), SourceKind.Script);
        assert.strictEqual(classifySource('system.adapter.zigbee.0'), SourceKind.Adapter);
        assert.strictEqual(classifySource('system.host.raspi'), SourceKind.System);
        assert.strictEqual(classifySource(undefined), SourceKind.System);
    });
});
