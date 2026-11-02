const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { Subject, Subscription } = require('rxjs')

function fixture () {
    const exports = {}
    let headers = []
    const document = { body: {}, querySelectorAll: () => headers, createElement: () => ({
        className: '', style: {}, children: [], attributes: {},
        setAttribute (key, value) { this.attributes[key] = value },
        getAttribute (key) { return this.attributes[key] },
        appendChild (child) { this.children.push(child) },
        remove () { if (this.parent) this.parent.rail = null },
    }) }
    const context = {
        exports, document, window: { localStorage: { sidebarPlusActiveWorkspace: 'pro' } },
        setTimeout, clearTimeout, Element: class {}, MutationObserver: class { observe () {} disconnect () {} },
        require: name => name === './profileTags' ? { profileTagColor: () => 'red', profileTagBackground: () => 'pink' } : name === 'rxjs' ? { Subscription } : name === '@angular/core'
            ? { Injectable: () => target => target } : {},
    }
    const js = ts.transpileModule(fs.readFileSync('src/workspaceTabs.service.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true },
    }).outputText
    vm.runInNewContext(js, context)
    const events = Object.fromEntries(['ready$', 'tabOpened$', 'tabsChanged$', 'activeTabChange$'].map(k => [k, new Subject()]))
    const app = { ...events, tabs: [], activeTab: null, selectTab (tab) { this.activeTab = tab; this.activeTabChange$.next(tab) } }
    const config = { changed$: new Subject(), store: { groups: [], sidebarPlus: {
        enabled: true, showWorkspaces: true, workspaceTabs: true,
        workspaces: [{ id: 'pro' }, { id: 'dev' }], profileWorkspaceIds: { p: 'pro', d: 'dev' },
    } } }
    const service = new exports.SidebarPlusWorkspaceTabsService(app, config)
    const add = tab => {
        app.tabs.push(tab)
        const classes = new Set()
        headers.push({ rail: null, querySelector (selector) { return selector === '.sidebar-plus-terminal-tags' ? this.rail : null }, insertBefore (rail) { this.rail = rail; rail.parent = this }, classList: { toggle: (key, value) => value ? classes.add(key) : classes.delete(key), remove: key => classes.delete(key) }, classes })
        return tab
    }
    const hidden = index => headers[index].classes.has('sidebar-plus-workspace-tab-hidden')
    return { app, config, service, add, hidden, headers, mismatch: () => headers.pop() }
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

test('shared profiles opened in All are not claimed by the next workspace', () => {
    const f = fixture(); f.service.setWorkspace('all'); f.add({ profile: { id: 'shared' } }); f.service.sync()
    f.service.setWorkspace('dev'); f.service.sync(); assert.equal(f.hidden(0), true); f.service.ngOnDestroy()
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
    assert.equal(f.headers[0].rail.children[2].textContent, '<prod>')
    f.config.store.sidebarPlus.profileTags.p = ['updated']; f.service.sync()
    assert.equal(f.headers[0].rail.children.length, 1)
    assert.equal(f.headers[0].rail.children[0].textContent, 'updated')
    f.config.store.sidebarPlus.showTerminalTabTags = false; f.service.sync()
    assert.equal(f.headers[0].rail, null); f.service.ngOnDestroy()
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
