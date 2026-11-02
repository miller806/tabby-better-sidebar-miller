const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { Subject, Subscription } = require('rxjs')

function fixture (storage = { sidebarPlusActiveWorkspace: 'pro' }) {
    const exports = {}
    const observers = []
    let outside = false
    let outsideTimers = 0
    const strip = { scrollLeft: 0, scrollTop: 0, closest: () => null, getBoundingClientRect: () => ({left:0,right:300,top:0,bottom:60}) }
    let headers = []
    const listeners = {}
    const document = { body: {}, querySelectorAll: () => headers,
        addEventListener (type, handler) { (listeners[type] = listeners[type] ?? []).push(handler) },
        removeEventListener (type, handler) { listeners[type] = (listeners[type] ?? []).filter(h => h !== handler) },
        createElement: () => ({
        className: '', style: {}, children: [], attributes: {},
        setAttribute (key, value) { this.attributes[key] = value },
        getAttribute (key) { return this.attributes[key] },
        appendChild (child) { this.children.push(child) },
        remove () { if (this.parent) this.parent.rail = null },
    }) }
    const context = {
        exports, document, window: { localStorage: storage },
        setTimeout: (...args) => { if (outside) outsideTimers++; return setTimeout(...args) }, clearTimeout,
        Element: class {}, ResizeObserver: class { observe () {} disconnect () {} }, MutationObserver: class {
            constructor (callback) { this.callback = callback; this.outside = outside; observers.push(this) }
            observe (target, options) { this.target = target; this.options = options }
            disconnect () { this.disconnected = true }
        },
        require: name => name === './profileTags' ? { profileTagColor: () => 'red', profileTagBackground: () => 'pink' } : name === 'rxjs' ? { Subscription } : name === '@angular/core'
            ? { Injectable: () => target => target } : {},
    }
    const js = ts.transpileModule(fs.readFileSync('src/workspaceTabs.service.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    }).outputText
    vm.runInNewContext(js, context)
    const events = Object.fromEntries(['ready$', 'tabOpened$', 'tabsChanged$', 'activeTabChange$', 'tabDragActive$'].map(k => [k, new Subject()]))
    const app = { ...events, tabs: [], activeTab: null, selectTab (tab) { this.activeTab = tab; this.activeTabChange$.next(tab) } }
    const config = { changed$: new Subject(), store: { groups: [], sidebarPlus: {
        enabled: true, showWorkspaces: true, workspaceTabs: true,
        workspaces: [{ id: 'pro' }, { id: 'dev' }], profileWorkspaceIds: { p: 'pro', d: 'dev' },
    } } }
    const service = new exports.SidebarPlusWorkspaceTabsService(app, config, {
        runOutsideAngular (fn) { const before = outside; outside = true; try { return fn() } finally { outside = before } },
        run: fn => fn(),
    }, { t: message => message })
    const add = tab => {
        app.tabs.push(tab)
        const classes = new Set()
        headers.push({ getBoundingClientRect: () => ({left:0,right:150,top:0,bottom:60}), parentElement: strip, rail: null, querySelector (selector) { return selector === '.sidebar-plus-terminal-tags' ? this.rail : null }, insertBefore (rail) { this.rail = rail; rail.parent = this }, classList: { toggle: (key, value) => value ? classes.add(key) : classes.delete(key), remove: key => classes.delete(key) }, classes })
        return tab
    }
    const hidden = index => headers[index].classes.has('sidebar-plus-workspace-tab-hidden')
    return { app, config, service, add, hidden, headers, observers, strip, storage, interact: () => { for (const handler of [...(listeners.pointerdown ?? [])]) handler() }, outsideTimers: () => outsideTimers, mismatch: () => headers.pop() }
}

test('switching workspaces hides headers without removing or destroying sessions', () => {
    const f = fixture(); const pro = f.add({ profile: { id: 'p' } }); const dev = f.add({ profile: { id: 'd' } })
    f.app.activeTab = pro; f.service.sync()
    assert.equal(f.hidden(0), false); assert.equal(f.hidden(1), true)
    f.service.setWorkspace('dev'); f.service.sync()
    assert.equal(f.hidden(0), true); assert.equal(f.hidden(1), false); assert.equal(f.app.activeTab, dev)
    assert.deepEqual(f.app.tabs, [pro, dev]); f.service.ngOnDestroy()
})

test('All and disabling the switch restore every header', () => {
    const f = fixture(); f.add({ profile: { id: 'p' } }); f.add({ profile: { id: 'd' } }); f.service.sync()
    f.service.setWorkspace('all'); f.service.sync(); assert.equal(f.hidden(1), false)
    f.service.setWorkspace('pro'); f.service.sync(); f.config.store.sidebarPlus.workspaceTabs = false
    f.service.sync(); assert.equal(f.hidden(0), false); assert.equal(f.hidden(1), false); f.service.ngOnDestroy()
})

test('tool tabs remain visible and a workspace with no tabs has no active terminal', () => {
    const f = fixture(); f.add({ profile: { id: 'p' } }); f.service.sync()
    f.service.setWorkspace('dev'); f.service.sync(); assert.equal(f.app.activeTab, null)
    const settings = f.add({ title: 'Settings' }); f.service.sync()
    assert.equal(f.app.activeTab, settings); assert.equal(f.hidden(1), false); f.service.ngOnDestroy()
})

test('re-opening the same profile in another workspace moves its recorded workspace', () => {
    const storage = { sidebarPlusActiveWorkspace: 'pro' }
    const first = fixture(storage); first.app.ready$.next()
    const tab = first.add({ profile: { id: 'shared' } }); first.app.tabOpened$.next(tab); first.service.sync()
    first.service.setWorkspace('dev'); first.service.sync(); assert.equal(first.hidden(0), true)
    first.service.ngOnDestroy()

    storage.sidebarPlusActiveWorkspace = 'dev'
    const second = fixture(storage); second.app.ready$.next(); second.interact()
    const reopened = second.add({ profile: { id: 'shared' } }); second.app.tabOpened$.next(reopened); second.service.sync()
    assert.equal(second.hidden(0), false)
    second.service.ngOnDestroy()

    const third = fixture({ ...storage }); third.app.ready$.next()
    third.add({ profile: { id: 'shared' } }); third.service.sync()
    assert.equal(third.hidden(0), false)
    third.service.setWorkspace('pro'); third.service.sync(); assert.equal(third.hidden(0), true)
    third.service.ngOnDestroy()
})

test('a shared profile opened while All is selected is never tied to a workspace', () => {
    const f = fixture(); f.service.setWorkspace('all'); f.add({ profile: { id: 'shared' } }); f.service.sync()
    f.service.setWorkspace('dev'); f.service.sync(); assert.equal(f.hidden(0), false)
    f.service.setWorkspace('pro'); f.service.sync(); assert.equal(f.hidden(0), false); f.service.ngOnDestroy()
})

test('a session returns to the workspace it was opened in after a restart', () => {
    const storage = { sidebarPlusActiveWorkspace: 'pro' }
    const first = fixture(storage); first.app.ready$.next()
    const tab = first.add({ profile: { id: 'shared' } }); first.app.tabOpened$.next(tab); first.service.sync()
    first.service.setWorkspace('dev'); first.service.sync(); assert.equal(first.hidden(0), true)
    first.service.ngOnDestroy()

    const second = fixture(storage); second.app.ready$.next()
    second.add({ profile: { id: 'shared' } }); second.service.sync()
    assert.equal(second.hidden(0), false)
    second.service.setWorkspace('dev'); second.service.sync(); assert.equal(second.hidden(0), true)
    second.service.ngOnDestroy()
})

test('a restored session keeps its workspace instead of adopting the selected one', () => {
    const storage = { sidebarPlusActiveWorkspace: 'pro' }
    const first = fixture(storage); first.app.ready$.next()
    const tab = first.add({ profile: { id: 'shared' } }); first.app.tabOpened$.next(tab); first.service.sync()
    first.service.ngOnDestroy()

    // The user closed Tabby while looking at dev, then reopened it.
    storage.sidebarPlusActiveWorkspace = 'dev'
    const second = fixture(storage); second.app.ready$.next()
    const restored = second.add({ profile: { id: 'shared' } }); second.app.tabOpened$.next(restored); second.service.sync()
    assert.equal(second.hidden(0), true)
    second.service.setWorkspace('pro'); second.service.sync(); assert.equal(second.hidden(0), false)
    second.service.ngOnDestroy()
})

test('a restored session whose profile was still loading is not claimed by the selected workspace', () => {
    const f = fixture(); f.app.ready$.next()
    const tab = f.add({ profile: undefined }); f.service.sync()
    assert.equal(f.hidden(0), false)
    // Recovery attaches the profile a moment later, with no workspace assignment.
    tab.profile = { id: 'shared' }; f.service.sync()
    assert.equal(f.hidden(0), false)
    f.service.setWorkspace('dev'); f.service.sync(); assert.equal(f.hidden(0), false)
    f.service.ngOnDestroy()
})

test('split tabs follow inherited group ownership as a whole', () => {
    const f = fixture(); f.config.store.groups = [{ id: 'child', parentGroupId: 'parent' }]
    f.config.store.sidebarPlus.groupWorkspaceIds = { parent: 'dev' }
    f.add({ getAllTabs: () => [{ profile: { group: 'child' } }, { profile: { id: 'p' } }] })
    f.service.sync(); assert.equal(f.hidden(0), true)
    f.service.setWorkspace('dev'); f.service.sync(); assert.equal(f.hidden(0), false); f.service.ngOnDestroy()
})

test('deleting a workspace and host header mismatch fail open', () => {
    const f = fixture(); f.add({ profile: { id: 'd' } }); f.service.sync(); assert.equal(f.hidden(0), true)
    f.config.store.sidebarPlus.workspaces = [{ id: 'pro' }]; f.service.sync(); assert.equal(f.hidden(0), false)
    f.config.store.sidebarPlus.workspaces.push({ id: 'dev' }); f.add({ profile: { id: 'p' } }); f.service.sync()
    f.mismatch(); f.service.sync(); assert.equal(f.hidden(0), false); f.service.ngOnDestroy()
})

test('tab-open events attach shared profiles to the current workspace', () => {
    const f = fixture(); f.app.ready$.next()
    const tab = f.add({ profile: { id: 'shared' } }); f.app.tabOpened$.next(tab); f.service.sync()
    f.service.setWorkspace('dev'); f.service.sync(); assert.equal(f.hidden(0), true)
    f.service.ngOnDestroy(); assert.equal(f.hidden(0), false)
})


test('next and previous tab navigation skip hidden workspaces', () => {
    const f = fixture(); f.app.ready$.next()
    const first = f.add({ profile: { id: 'p' } })
    const hidden = f.add({ profile: { id: 'd' } })
    const last = f.add({ profile: { id: 'p' } })
    f.app.selectTab(first); f.service.sync()
    f.app.selectTab(hidden); f.service.sync(); assert.equal(f.app.activeTab, last)
    f.app.selectTab(hidden); f.service.sync(); assert.equal(f.app.activeTab, first)
    f.service.ngOnDestroy()
})

test('each workspace restores its last selected terminal', () => {
    const f = fixture(); f.app.ready$.next()
    f.add({ profile: { id: 'p' } }); const last = f.add({ profile: { id: 'p' } })
    const dev = f.add({ profile: { id: 'd' } }); f.app.selectTab(last); f.service.sync()
    f.service.setWorkspace('dev'); f.service.sync(); assert.equal(f.app.activeTab, dev)
    f.service.setWorkspace('pro'); f.service.sync(); assert.equal(f.app.activeTab, last)
    f.config.store.sidebarPlus.enabled = false; f.service.sync(); assert.equal(f.hidden(2), false)
    f.service.ngOnDestroy()
})


test('terminal header tags show every label and update without enabling workspace filtering', () => {
    const f = fixture()
    f.config.store.sidebarPlus.workspaceTabs = false
    f.config.store.sidebarPlus.showTerminalTabTags = true
    f.config.store.sidebarPlus.profileTags = { p: ['flink', 'seatunnel', '<prod>'] }
    f.add({ profile: { id: 'p' } }); f.service.sync()
    assert.equal(f.headers[0].rail.children.length, 3)
    assert.equal(f.headers[0].classes.has('sidebar-plus-has-tags'), true)
    assert.equal(f.headers[0].rail.children[2].textContent, '<prod>')
    f.config.store.sidebarPlus.profileTags.p = ['updated']; f.service.sync()
    assert.equal(f.headers[0].rail.children.length, 1)
    assert.equal(f.headers[0].rail.children[0].textContent, 'updated')
    f.config.store.sidebarPlus.showTerminalTabTags = false; f.service.sync()
    assert.equal(f.headers[0].rail, null)
    assert.equal(f.headers[0].classes.has('sidebar-plus-has-tags'), false)
    f.service.ngOnDestroy()
})


test('active sessions follow their top-level split workspace only when filtering is enabled', () => {
    const f = fixture()
    const pane = { profile: { id: 'd' } }
    f.add({ getAllTabs: () => [pane] }); f.service.sync()
    assert.equal(f.service.isSessionVisible(pane), false)
    f.service.setWorkspace('dev'); assert.equal(f.service.isSessionVisible(pane), true)
    f.service.setWorkspace('all'); assert.equal(f.service.isSessionVisible(pane), true)
    f.service.setWorkspace('pro'); f.config.store.sidebarPlus.workspaceTabs = false
    assert.equal(f.service.isSessionVisible(pane), true); f.service.ngOnDestroy()
})


test('disabled options register no DOM observer and schedule no header work', () => {
    const f = fixture(); f.config.store.sidebarPlus.workspaceTabs = false
    f.add({ profile: { id: 'p' } }); f.app.ready$.next()
    for (let i = 0; i < 1000; i++) f.app.tabsChanged$.next()
    assert.equal(f.observers.length, 0); assert.equal(f.outsideTimers(), 0)
    assert.equal(f.service.pending, undefined); f.service.ngOnDestroy()
})

test('enabled observer watches only header siblings outside Angular and stops on disable', () => {
    const f = fixture(); f.add({ profile: { id: 'p' } }); f.app.ready$.next(); f.service.sync()
    assert.equal(f.observers.length, 1)
    assert.equal(f.observers[0].target, f.strip)
    assert.equal(f.observers[0].options.childList, true)
    assert.equal(f.observers[0].options.subtree, undefined)
    assert.equal(f.observers[0].outside, true)
    assert.equal(f.outsideTimers(), 1)
    f.config.store.sidebarPlus.workspaceTabs = false; f.config.changed$.next(); f.service.sync()
    assert.equal(f.observers[0].disconnected, true)
    f.service.ngOnDestroy()
})

test('repeating the same workspace does not schedule refreshes', () => {
    const f = fixture()
    for (let i = 0; i < 1000; i++) f.service.setWorkspace('pro')
    assert.equal(f.outsideTimers(), 0); assert.equal(f.service.visibilityRevision, 0)
    f.service.setWorkspace('dev'); assert.equal(f.outsideTimers(), 1)
    f.service.ngOnDestroy()
})


test('session list memoizes repeated Angular checks and bypasses filtering when disabled', () => {
    const source = ts.createSourceFile('tree.ts', fs.readFileSync('src/components/sidebarTree.component.ts', 'utf8'), ts.ScriptTarget.Latest, true)
    const tree = source.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'SidebarPlusTreeComponent')
    const members = tree.members.filter(n => n.name && ['visibleActiveSessions', 'visibleSessionSource', 'visibleSessionRevision', 'visibleSessionCache'].includes(n.name.getText(source)))
    const exports = {}
    const js = ts.transpileModule('class Subject {' + members.map(n => n.getText(source)).join('\n') + '}; exports.Subject = Subject', {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText
    vm.runInNewContext(js, { exports })
    const view = new exports.Subject()
    let scans = 0
    view.activeSessions = [{ tab: 1 }, { tab: 2 }]
    view.workspaceTabs = { filtersSessions: true, visibilityRevision: 0, isSessionVisible: () => { scans++; return true } }
    const first = view.visibleActiveSessions
    for (let i = 0; i < 1000; i++) assert.equal(view.visibleActiveSessions, first)
    assert.equal(scans, 2)
    view.workspaceTabs.visibilityRevision++
    assert.notEqual(view.visibleActiveSessions, first); assert.equal(scans, 4)
    view.workspaceTabs.filtersSessions = false
    assert.equal(view.visibleActiveSessions, view.activeSessions); assert.equal(scans, 4)
})


test('dragging suspends DOM synchronization until native reorder completes', () => {
    const f = fixture(); f.app.ready$.next()
    const pro = f.add({ profile: { id: 'p' } }); f.add({ profile: { id: 'd' } }); f.service.sync()
    assert.equal(f.hidden(1), true)
    const timers = f.outsideTimers()
    f.app.tabDragActive$.next(pro)
    f.config.store.sidebarPlus.workspaceTabs = false
    f.app.tabsChanged$.next(); f.service.sync()
    assert.equal(f.hidden(1), true); assert.equal(f.outsideTimers(), timers)
    f.app.tabDragActive$.next(null); f.service.sync()
    assert.equal(f.hidden(1), false); f.service.ngOnDestroy()
})

test('selecting an overflowed tab reveals it without resetting manual scroll on unrelated refreshes', () => {
    const f = fixture(); f.app.ready$.next()
    f.config.store.sidebarPlus.workspaceTabs = false; f.config.store.sidebarPlus.showTerminalTabTags = true
    const tab = f.add({ profile: { id: 'p' } })
    f.headers[0].getBoundingClientRect = () => ({left:500,right:650,top:0,bottom:60})
    f.app.selectTab(tab); f.service.sync(); assert.equal(f.strip.scrollLeft, 350)
    f.strip.scrollLeft = 0; f.service.sync(); assert.equal(f.strip.scrollLeft, 0)
    f.service.ngOnDestroy()
})
