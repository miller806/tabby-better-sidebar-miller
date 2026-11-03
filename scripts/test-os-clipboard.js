const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

/**
 * The OS-clipboard readers are pure functions on purpose: a wrong parse here
 * uploads the wrong local file, and Electron's clipboard cannot be exercised in
 * a test. `electronRemote` and `fs` are stubbed; nothing below reaches either.
 */
function load () {
    const exports = {}
    const context = {
        exports,
        Buffer,
        URL,
        require: name => {
            if (name === './electronRemote') {
                return { electronRemote: () => null }
            }
            if (name === 'fs') {
                return { existsSync: () => true }
            }
            return {}
        },
    }
    const js = ts.transpileModule(fs.readFileSync('src/osClipboard.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText
    vm.runInNewContext(js, context)
    return exports
}

test('FileNameW paths are split on NUL and survive the double terminator', () => {
    const { parseFileNameW } = load()
    const buffer = Buffer.from('C:\\Users\\me\\a.txt\u0000D:\\data\\b c.txt\u0000\u0000', 'utf16le')
    assert.deepEqual(Array.from(parseFileNameW(buffer)), ['C:\\Users\\me\\a.txt', 'D:\\data\\b c.txt'])
    assert.deepEqual(Array.from(parseFileNameW(Buffer.from('\u0000\u0000', 'utf16le'))), [])
})

test('uri lists yield local paths only, decoded', () => {
    const { parseUriList } = load()
    const text = [
        '# copied from a file manager',
        'file:///home/me/report%20final.pdf',
        '',
        'file:///C:/Users/me/notes.txt',
        'https://example.com/not-a-file',
        'file:///tmp/dir/',
    ].join('\r\n')
    assert.deepEqual(
        Array.from(parseUriList(text)),
        ['/home/me/report final.pdf', 'C:/Users/me/notes.txt', '/tmp/dir/'],
    )
    assert.deepEqual(Array.from(parseUriList('')), [])
})

test('a file URI keeps its path, a Windows drive loses the leading slash, others are refused', () => {
    const { localPathFromUri } = load()
    assert.equal(localPathFromUri('file:///home/me/a.txt'), '/home/me/a.txt')
    assert.equal(localPathFromUri('file:///C:/Users/me/a.txt'), 'C:/Users/me/a.txt')
    assert.equal(localPathFromUri('file:///tmp/with%20space/x'), '/tmp/with space/x')
    assert.equal(localPathFromUri('http://example.com/x'), null)
    assert.equal(localPathFromUri('not a url'), null)
    assert.equal(localPathFromUri('file:///%E0%A4%A'), null)
})
