'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS, HELP } = require('../../build/lib/help');
const { CATEGORIES } = require('../../build/lib/categories');

/** The commands of the switch in `onMessage` of src/main.ts */
function commandsOfMain() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/main.ts'), 'utf8');
    const start = source.indexOf('private onMessage(');
    const end = source.indexOf('private handleGetHistory(');
    assert.ok(start > 0 && end > start, 'onMessage found');
    return [...source.slice(start, end).matchAll(/case '([^']+)':/g)].map(m => m[1]);
}

describe('help', () => {
    it('lists exactly the commands onMessage answers', () => {
        assert.deepStrictEqual([...COMMANDS].sort(), commandsOfMain().sort());
    });

    it('names every command, category and source for an agent', () => {
        for (const word of [
            ...COMMANDS.filter(c => c !== 'help'),
            ...CATEGORIES.map(c => c.key),
            'user',
            'script',
            'adapter',
            'system',
            'sendTo recorder.0',
            'simulation.enabled',
            'anomaly.ack',
            "only on the user's",
        ]) {
            assert.ok(HELP.includes(word), word);
        }
    });

    it('keeps the lines short', () => {
        for (const line of HELP.split('\n')) {
            assert.ok(line.length <= 120, line);
        }
    });
});
