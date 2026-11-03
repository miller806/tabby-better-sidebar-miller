const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { Subject, Subscription } = require('rxjs')

test('legacy folder exclusions override an incorrect restored workspace and survive another restart', () => {
    const storage = { sidebarPlusActiveWorkspace: 'dev', sidebarPlusSessionOwners: JSON.stringify([{ key: 'server102', workspace: 'dev' }]) }
    const setup = storage => {
        const f = fixture(storage)
        f.config.store.groups = [{ id: 'admin', parentGroupId: 'pro-folder' }, { id: 'pro-folder' }]
        f.config.store.profiles = [{ id: 'server102', group: 'admin' }]
        f.config.store.sidebarPlus.workspaces = [{ id: 'pro' }, { id: 'dev', hiddenGroupIds: ['pro-folder'] }, { id: 'private', hiddenGroupIds: ['pro-folder'] }]
        f.app.ready$.next()
        const tab = f.add({ profile: { id: 'server102' } }) // recovery can omit the group
        f.app.tabOpened$.next(tab); f.service.sync()
        return f
    }
    const first = setup(storage)
    assert.equal(first.hidden(0), true)
    first.service.setWorkspace('pro'); first.service.sync(); assert.equal(first.hidden(0), false)
    first.interact(); first.service.sync()
    assert.equal(JSON.parse(storage.sidebarPlusSessionOwners)[0].workspace, 'pro')
    first.service.ngOnDestroy()
    const second = setup({ ...storage }); assert.equal(second.hidden(0), true)
    second.service.setWorkspace('pro'); second.service.sync(); assert.equal(second.hidden(0), false)
    second.service.setWorkspace('all'); second.service.sync(); assert.equal(second.hidden(0), false)
    second.service.ngOnDestroy()
})

test('legacy profile exclusions override learned ownership and follow configuration changes', () => {
    const f = fixture(); f.app.ready$.next(); f.interact(); f.service.setWorkspace('dev')
    const tab = f.add({ profile: { id: 'legacy' } }); f.app.tabOpened$.next(tab)
    f.config.store.sidebarPlus.workspaces[1].hiddenProfileIds = ['legacy']
    f.service.sync(); assert.equal(f.hidden(0), true)
    f.service.setWorkspace('pro'); f.service.sync(); assert.equal(f.hidden(0), false)
    f.config.store.sidebarPlus.workspaces[1].hiddenProfileIds = []
    f.config.store.sidebarPlus.workspaces[0].hiddenProfileIds = ['legacy']
    f.service.sync(); assert.equal(f.hidden(0), true)
    f.service.ngOnDestroy()
})

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
        remove () { if (this.parent) this.parent[this.className.startsWith("sidebar-plus-connection-status") ? "indicator" : "rail"] = null },
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
        // The narrow-tab machinery (scroll strip) is on by default in the app;
        // these tests care about the workspace/tag ones, so it is off here.
        tabWidth: 'default',
        workspaces: [{ id: 'pro' }, { id: 'dev' }], profileWorkspaceIds: { p: 'pro', d: 'dev' },
    } } }
    const service = new exports.SidebarPlusWorkspaceTabsService(app, config, {
        runOutsideAngular (fn) { const before = outside; outside = true; try { return fn() } finally { outside = before } },
        run: fn => fn(),
    }, { t: message => message })
    const add = tab => {
        app.tabs.push(tab)
        const classes = new Set()
        headers.push({ getBoundingClientRect: () => ({left:0,right:150,top:0,bottom:60}), parentElement: strip, rail: null, indicator: null, querySelector (selector) { return selector === '.sidebar-plus-terminal-tags' ? this.rail : selector === '.sidebar-plus-connection-status' ? this.indicator : null }, insertBefore (element) { this[element.className.startsWith('sidebar-plus-connection-status') ? 'indicator' : 'rail'] = element; element.parent = this }, classList: { toggle: (key, value) => value ? classes.add(key) : classes.delete(key), remove: key => classes.delete(key) }, classes })
        return tab
    }
    const hidden = index => headers[index].classes.has('sidebar-plus-workspace-tab-hidden')
    return { app, config, service, add, hidden, headers, observers, strip, storage, interact: () => { for (const handler of [...(listeners.pointerdown ?? [])]) handler() }, outsideTimers: () => outsideTimers, mismatch: () => headers.pop() }
}

test('SSH header status updates on disconnect and reconnect without polling and releases subscriptions', async () => {
    const f = fixture(); f.config.store.sidebarPlus.showTerminalTabTags = true
    f.config.store.sidebarPlus.profileTags = { p: ['production'] }
    const changes = new Subject()
    const tab = f.add({ profile: { id: 'p', type: 'ssh' }, session: {}, sessionChanged$: changes })
    f.service.sync()
    assert.equal(f.headers[0].indicator.className, 'sidebar-plus-connection-status connected')
    assert.equal(changes.observers.length, 1)
    tab.session = null; changes.next(null)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(f.headers[0].indicator.title, 'Disconnected')
    assert.equal(f.headers[0].rail.children[0].textContent, 'production')
    tab.session = {}; changes.next(tab.session)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(f.headers[0].indicator.textContent, '●')
    f.config.store.sidebarPlus.showTerminalTabTags = false; f.service.sync()
    assert.equal(changes.observers.length, 0)
    assert.equal(f.headers[0].rail, null)
    assert.equal(f.headers[0].indicator, null)
    f.config.store.sidebarPlus.showTerminalTabTags = true; f.service.sync()
    f.service.ngOnDestroy(); assert.equal(changes.observers.length, 0)
})

test('SSH status is per session, includes untagged servers and warns for a disconnected split pane', () => {
    const f = fixture(); f.config.store.sidebarPlus.showTerminalTabTags = true
    f.add({ profile: { id: 'p', type: 'ssh' }, session: {} })
    f.add({ profile: { id: 'p', type: 'ssh' }, session: null })
    f.add({ getAllTabs: () => [{ profile: { type: 'ssh' }, session: {} }, { profile: { type: 'ssh' }, session: null }] })
    f.add({ profile: { type: 'local' }, session: null })
    f.service.sync()
    assert.equal(f.headers[0].indicator.textContent, '●')
    assert.equal(f.headers[1].indicator.title, 'Disconnected')
    assert.equal(f.headers[2].indicator.title, 'Disconnected')
    assert.equal(f.headers[3].rail, null)
    f.service.ngOnDestroy()
})

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
    const first = fixture(storage); first.app.ready$.next(); first.interact()
    const tab = first.add({ profile: { id: 'shared' } }); first.app.tabOpened$.next(tab); first.service.sync()
    first.service.setWorkspace('dev'); first.service.sync(); assert.equal(first.hidden(0), true)
    first.service.ngOnDestroy()

    // Reopened while dev is selected: the session still belongs to pro.
    const second = fixture({ ...storage, sidebarPlusActiveWorkspace: 'dev' }); second.app.ready$.next()
    second.add({ profile: { id: 'shared' } }); second.service.sync()
    assert.equal(second.hidden(0), true)
    second.service.setWorkspace('pro'); second.service.sync(); assert.equal(second.hidden(0), false)
    second.service.ngOnDestroy()
})

test('two sessions of the same profile keep their own workspace across a restart', () => {
    const storage = { sidebarPlusActiveWorkspace: 'pro' }
    const first = fixture(storage); first.app.ready$.next(); first.interact()
    const pro = first.add({ profile: { id: 'local' } }); first.app.tabOpened$.next(pro); first.service.sync()
    first.service.setWorkspace('dev'); first.service.sync()
    const dev = first.add({ profile: { id: 'local' } }); first.app.tabOpened$.next(dev); first.service.sync()
    assert.equal(JSON.parse(first.storage.sidebarPlusSessionOwners).length, 2)
    first.service.ngOnDestroy()

    const second = fixture({ ...storage }); second.app.ready$.next()
    const restoredPro = second.add({ profile: { id: 'local' } }); second.app.tabOpened$.next(restoredPro)
    const restoredDev = second.add({ profile: { id: 'local' } }); second.app.tabOpened$.next(restoredDev); second.service.sync()
    assert.equal(second.hidden(0), false); assert.equal(second.hidden(1), true)
    second.service.setWorkspace('dev'); second.service.sync()
    assert.equal(second.hidden(0), true); assert.equal(second.hidden(1), false)
    second.service.ngOnDestroy()
})

test('a session opened while All was selected stays unowned after a restart', () => {
    const storage = { sidebarPlusActiveWorkspace: 'all' }
    const first = fixture(storage); first.app.ready$.next(); first.interact()
    const shared = first.add({ profile: { id: 'shared' } }); first.app.tabOpened$.next(shared); first.service.sync()
    assert.equal(first.hidden(0), false)
    first.service.ngOnDestroy()

    const second = fixture({ ...storage, sidebarPlusActiveWorkspace: 'dev' }); second.app.ready$.next()
    const restored = second.add({ profile: { id: 'shared' } }); second.app.tabOpened$.next(restored); second.service.sync()
    assert.equal(second.hidden(0), false)
    second.service.setWorkspace('pro'); second.service.sync(); assert.equal(second.hidden(0), false)
    second.service.ngOnDestroy()
})

test('a session whose profile has no id keeps its workspace by position', () => {
    const storage = { sidebarPlusActiveWorkspace: 'pro' }
    const first = fixture(storage); first.app.ready$.next(); first.interact()
    const a = first.add({ profile: {} }); first.app.tabOpened$.next(a); first.service.sync()
    first.service.setWorkspace('dev'); first.service.sync()
    const b = first.add({ profile: {} }); first.app.tabOpened$.next(b); first.service.sync()
    first.service.ngOnDestroy()

    const second = fixture({ ...storage }); second.app.ready$.next()
    const r1 = second.add({ profile: {} }); second.app.tabOpened$.next(r1)
    const r2 = second.add({ profile: {} }); second.app.tabOpened$.next(r2); second.service.sync()
    assert.equal(second.hidden(0), false); assert.equal(second.hidden(1), true)
    second.service.setWorkspace('dev'); second.service.sync()
    assert.equal(second.hidden(0), true); assert.equal(second.hidden(1), false)
    second.service.ngOnDestroy()
})

test('a restored session keeps its workspace instead of adopting the selected one', () => {
    const storage = { sidebarPlusActiveWorkspace: 'pro' }
    const first = fixture(storage); first.app.ready$.next(); first.interact()
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

test('deleting a workspace and a lasting header mismatch fail open', () => {
    const f = fixture(); f.add({ profile: { id: 'd' } }); f.service.sync(); assert.equal(f.hidden(0), true)
    f.config.store.sidebarPlus.workspaces = [{ id: 'pro' }]; f.service.sync(); assert.equal(f.hidden(0), false)
    f.config.store.sidebarPlus.workspaces.push({ id: 'dev' }); f.add({ profile: { id: 'p' } }); f.service.sync()
    f.mismatch(); f.service.sync()
    // Within the grace period the previous visibility is kept, not revealed; see
    // the closing-tab test below. Past it, the guard rail still fails open.
    assert.equal(f.hidden(0), true)
    f.service.mismatchSince = Date.now() - 5000; f.service.sync()
    assert.equal(f.hidden(0), false); f.service.ngOnDestroy()
})

test('closing a tab never flashes the other workspaces for a frame', () => {
    const f = fixture(); f.app.ready$.next()
    f.add({ profile: { id: 'p' } }); f.add({ profile: { id: 'd' } }); f.add({ profile: { id: 'p' } })
    f.service.sync(); assert.equal(f.hidden(1), true)
    // Tabby drops the tab from app.tabs first and lets the header animate out,
    // so the counts disagree for a frame or two.
    f.app.tabs.pop(); f.service.sync()
    assert.equal(f.hidden(1), true)
    assert.equal(f.hidden(0), false)
    // The animation finishes, the counts agree again and nothing moved.
    f.mismatch(); f.service.sync()
    assert.equal(f.hidden(1), true); assert.equal(f.hidden(0), false)
    f.service.ngOnDestroy()
})

test('a busy window syncs without re-walking every workspace for every tab', () => {
    // Guards the caching behind the 1.0.26 smoothness pass: ownership used to
    // rescan the profile list, every folder ancestor and every workspace
    // exclusion for each pane of each tab, twice per sync. The bound is
    // deliberately loose — it is there to catch a return to that shape, not to
    // measure the machine it runs on.
    const f = fixture()
    f.config.store.sidebarPlus.workspaces = Array.from({ length: 12 }, (_, i) => ({
        id: `w${i}`,
        hiddenProfileIds: [],
        hiddenGroupIds: Array.from({ length: 40 }, (_, g) => `g${i}-${g}`),
    }))
    f.config.store.groups = Array.from({ length: 200 }, (_, i) => ({ id: `g${i % 12}-${i % 40}` }))
    f.config.store.profiles = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}` }))
    for (let i = 0; i < 60; i++) {
        f.add({ profile: { id: `p${i}` } })
    }
    f.service.sync()
    const start = process.hrtime.bigint()
    for (let i = 0; i < 50; i++) {
        f.service.sync()
    }
    const perSync = Number(process.hrtime.bigint() - start) / 50 / 1e6
    assert.ok(perSync < 5, `sync() took ${perSync.toFixed(2)} ms per call`)
    f.service.ngOnDestroy()
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


test('narrow tabs install the scroll strip machinery on their own', () => {
    const f = fixture(); f.app.ready$.next()
    f.config.store.sidebarPlus.workspaceTabs = false
    f.config.store.sidebarPlus.showTerminalTabTags = false
    // Tabby's 200px cards fit three tabs on a wide window; the narrow setting
    // overflows, and the strip's scroll buttons are what makes that usable.
    f.add({ profile: { id: 'p' } })
    f.service.sync()
    assert.equal(f.observers.length, 0)
    f.config.store.sidebarPlus.tabWidth = 'compact'
    f.app.tabsChanged$.next(); f.service.sync()
    assert.equal(f.observers.length, 1)
    f.config.store.sidebarPlus.tabWidth = 'default'
    f.app.tabsChanged$.next(); f.service.sync()
    assert.equal(f.observers[0].disconnected, true)
    f.service.ngOnDestroy()
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
