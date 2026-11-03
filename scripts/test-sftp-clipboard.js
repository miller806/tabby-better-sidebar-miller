const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

/**
 * The paste decision is the part of the SFTP clipboard that can destroy files
 * when it is wrong — overwriting a name that already exists, or walking a
 * directory into its own copy. It is deliberately a pure function so it can be
 * checked here without an SFTP session, a panel or a server.
 */
function load () {
    const exports = {}
    const context = {
        exports,
        require: name => name === '@angular/core' ? { Injectable: () => target => target } : {},
    }
    const js = ts.transpileModule(fs.readFileSync('src/sftpClipboard.service.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    }).outputText
    vm.runInNewContext(js, context)
    return exports
}

/** Names of a plan list, rebuilt here: the planner's arrays come from another realm. */
const names = list => Array.from(list, item => item.name)

/** Rejections as plain pairs, for the same reason. */
const rejections = plan => Array.from(plan.rejected, r => [r.entry.name, r.reason])

const entry = (name, parent = '/srv') => ({
    name,
    path: `${parent}/${name}`,
    isDirectory: false,
    size: 10,
    mode: 0o644,
})

test('a path is inside itself and its descendants, with the separator respected', () => {
    const { isPathInside } = load()
    assert.equal(isPathInside('/srv/data', '/srv/data'), true)
    assert.equal(isPathInside('/srv/data', '/srv/data/file.txt'), true)
    assert.equal(isPathInside('/srv/data', '/srv/data/sub/dir'), true)
    // The prefix trap: a sibling whose name merely starts the same way.
    assert.equal(isPathInside('/srv/data', '/srv/database/file.txt'), false)
    assert.equal(isPathInside('/srv/data', '/srv'), false)
    // A trailing slash on the ancestor must not double it.
    assert.equal(isPathInside('/srv/data/', '/srv/data/file.txt'), true)
})

test('a copy is transferred while a cut inside the same session is a rename', () => {
    const { planPaste } = load()
    const entries = [entry('a.txt'), entry('b.txt')]
    const copied = planPaste({ entries, destination: '/srv/other', existingNames: [], sameSession: true, cut: false })
    assert.equal(copied.move.length, 0)
    assert.deepEqual(names(copied.transfer), ['a.txt', 'b.txt'])
    assert.equal(copied.rejected.length, 0)

    const cut = planPaste({ entries, destination: '/srv/other', existingNames: [], sameSession: true, cut: true })
    assert.deepEqual(names(cut.move), ['a.txt', 'b.txt'])
    assert.equal(cut.transfer.length, 0)
})

test('a cut across sessions is transferred rather than renamed', () => {
    const { planPaste } = load()
    const plan = planPaste({ entries: [entry('a.txt')], destination: '/home/u', existingNames: [], sameSession: false, cut: true })
    assert.equal(plan.move.length, 0)
    assert.deepEqual(names(plan.transfer), ['a.txt'])
})

test('an existing name is refused instead of overwritten', () => {
    const { planPaste } = load()
    const plan = planPaste({
        entries: [entry('a.txt'), entry('b.txt')],
        destination: '/srv/other',
        existingNames: ['a.txt'],
        sameSession: true,
        cut: false,
    })
    assert.deepEqual(names(plan.transfer), ['b.txt'])
    assert.deepEqual(rejections(plan), [['a.txt', 'exists']])
})

test('an entry cannot be pasted into its own subtree', () => {
    const { planPaste } = load()
    const directory = { ...entry('data'), isDirectory: true }
    for (const destination of ['/srv/data', '/srv/data/sub']) {
        const plan = planPaste({ entries: [directory], destination, existingNames: [], sameSession: true, cut: true })
        assert.equal(plan.move.length, 0, destination)
        assert.equal(plan.transfer.length, 0, destination)
        assert.deepEqual(rejections(plan), [['data', 'inside']], destination)
    }
    // A sibling with a shared prefix is a perfectly valid destination.
    const sibling = planPaste({ entries: [directory], destination: '/srv/database', existingNames: [], sameSession: true, cut: true })
    assert.deepEqual(names(sibling.move), ['data'])
})

test('the clipboard keeps its entries, its cut flag and its source session', () => {
    const { SidebarPlusSftpClipboardService } = load()
    const clipboard = new SidebarPlusSftpClipboardService()
    const source = {}
    assert.equal(clipboard.hasEntries, false)
    assert.equal(clipboard.isFrom(source), false)

    clipboard.set([entry('a.txt')], true, source)
    assert.equal(clipboard.hasEntries, true)
    assert.equal(clipboard.count, 1)
    assert.equal(clipboard.cut, true)
    assert.equal(clipboard.isFrom(source), true)
    assert.equal(clipboard.isFrom({}), false)

    clipboard.clear()
    assert.equal(clipboard.hasEntries, false)
    assert.equal(clipboard.cut, false)
    assert.equal(clipboard.isFrom(source), false)
})

/**
 * The placement service is what keeps the SFTP view in exactly one host: the
 * dock at the right of the window, or the sidebar it replaces. The default
 * matters — an older config has no `sftpPlacement` at all.
 */
function loadView (sidebarPlus) {
    const exports = {}
    const context = {
        exports,
        require: name => {
            if (name === '@angular/core') {
                return { Injectable: () => target => target }
            }
            if (name === 'tabby-core') {
                return { ConfigService: class {} }
            }
            return {}
        },
    }
    const js = ts.transpileModule(fs.readFileSync('src/sftpView.service.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    }).outputText
    vm.runInNewContext(js, context)
    return new exports.SidebarPlusSftpViewService({ store: { sidebarPlus } })
}

test('the SFTP view defaults to the right-hand dock, and can be asked for the sidebar', () => {
    const docked = loadView({})
    assert.equal(docked.placement, 'right')
    assert.equal(docked.inDock, true)
    assert.equal(docked.visible, false)
    docked.toggle()
    assert.equal(docked.visible, true)
    docked.hide()
    assert.equal(docked.visible, false)
    docked.show()
    assert.equal(docked.visible, true)

    const sidebar = loadView({ sftpPlacement: 'sidebar' })
    assert.equal(sidebar.placement, 'sidebar')
    assert.equal(sidebar.inDock, false)
})
