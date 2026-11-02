import { profileTagColor, profileTagBackground } from './profileTags'
import { Injectable, NgZone, OnDestroy } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, PartialProfile, Profile } from 'tabby-core'
import { Subscription } from 'rxjs'

const HIDDEN_CLASS = 'sidebar-plus-workspace-tab-hidden'

/** Filters headers without removing tabs from Tabby: recovery, shutdown and sessions keep all tabs. */
@Injectable({ providedIn: 'root' })
export class SidebarPlusWorkspaceTabsService implements OnDestroy {
    private workspaceId = window.localStorage.sidebarPlusActiveWorkspace ?? 'all'
    private owners = new WeakMap<BaseTabComponent, string>()
    private lastActive = new Map<string, BaseTabComponent>()
    private subscription = new Subscription()
    private observer?: MutationObserver
    private pending?: ReturnType<typeof setTimeout>
    private changingFocus = false
    private navigationDirection = 0
    private observedStrip?: Element
    private applied = false
    visibilityRevision = 0

    constructor (private app: AppService, private config: ConfigService, private zone: NgZone) {
        this.subscription.add(this.app.ready$.subscribe(() => {
            this.subscription.add(this.app.tabOpened$.subscribe(tab => {
                this.owners.set(tab, this.profileOwner(tab) ?? this.currentWorkspace())
                this.visibilityRevision++
                this.schedule()
            }))
            this.subscription.add(this.app.tabsChanged$.subscribe(() => { this.visibilityRevision++; this.schedule() }))
            this.subscription.add(this.app.activeTabChange$.subscribe(tab => {
                if (this.changingFocus) {
                    return
                }
                if (tab && this.visible(tab)) {
                    this.lastActive.set(this.currentWorkspace(), tab)
                } else if (tab) {
                    const previous = this.lastActive.get(this.currentWorkspace())
                    const from = previous ? this.app.tabs.indexOf(previous) : -1
                    const to = this.app.tabs.indexOf(tab)
                    const count = this.app.tabs.length
                    this.navigationDirection = from >= 0 && to === (from + 1) % count ? 1
                        : from >= 0 && to === (from - 1 + count) % count ? -1 : 0
                }
                this.schedule()
            }))
            this.subscription.add(this.config.changed$.subscribe(() => { this.visibilityRevision++; this.schedule() }))
            this.schedule()
        }))
    }

    setWorkspace (id: string): void {
        if (id === this.workspaceId) {
            return
        }
        this.visibilityRevision++
        if (id !== this.workspaceId && this.app.activeTab && this.visible(this.app.activeTab)) {
            this.lastActive.set(this.currentWorkspace(), this.app.activeTab)
        }
        this.workspaceId = id
        this.navigationDirection = 0
        this.schedule()
    }

    get filtersSessions (): boolean {
        return this.enabled() && this.currentWorkspace() !== 'all'
    }

    isSessionVisible (tab: BaseTabComponent): boolean {
        if (!this.filtersSessions) {
            return true
        }
        const root = this.app.tabs.find(candidate => candidate === tab || this.panes(candidate).includes(tab))
        return !root || this.visible(root)
    }

    private currentWorkspace (): string {
        const sp = this.config.store.sidebarPlus
        return sp?.workspaces?.some((w: { id: string }) => w.id === this.workspaceId) ? this.workspaceId : 'all'
    }

    private enabled (): boolean {
        const sp = this.config.store.sidebarPlus
        return !!sp?.workspaceTabs && (sp.enabled ?? true) && (sp.showWorkspaces ?? true)
    }

    private panes (tab: BaseTabComponent): BaseTabComponent[] {
        // Structural check also works when the host loaded another copy of a tab class.
        const split = tab as BaseTabComponent & { getAllTabs?: () => BaseTabComponent[] }
        return split.getAllTabs ? split.getAllTabs() : [tab]
    }

    private profileOwner (tab: BaseTabComponent): string|undefined {
        const sp = this.config.store.sidebarPlus
        for (const pane of this.panes(tab)) {
            const profile = (pane as BaseTabComponent & { profile?: PartialProfile<Profile> }).profile
            if (!profile) {
                continue
            }
            const owner = profile.id ? sp?.profileWorkspaceIds?.[profile.id] : undefined
            if (owner) {
                return owner
            }
            let groupId = profile.group
            const visited = new Set<string>()
            while (groupId && !visited.has(groupId)) {
                visited.add(groupId)
                if (sp?.groupWorkspaceIds?.[groupId]) {
                    return sp.groupWorkspaceIds[groupId]
                }
                groupId = this.config.store.groups?.find((g: { id: string }) => g.id === groupId)?.parentGroupId
            }
        }
        return undefined
    }

    private visible (tab: BaseTabComponent): boolean {
        const workspace = this.currentWorkspace()
        if (!this.enabled() || workspace === 'all') {
            return true
        }
        // Settings and other tools stay accessible in every workspace.
        if (!this.panes(tab).some(p => !!(p as BaseTabComponent & { profile?: unknown }).profile)) {
            return true
        }
        let owner = this.owners.get(tab)
        if (!owner) {
            owner = this.profileOwner(tab) ?? workspace
            this.owners.set(tab, owner)
        }
        // A deleted workspace must not leave running sessions unreachable.
        if (owner !== 'all' && !this.config.store.sidebarPlus?.workspaces?.some((w: { id: string }) => w.id === owner)) {
            return true
        }
        return owner === workspace
    }

    private needsHeaders (): boolean {
        const sp = this.config.store.sidebarPlus
        return this.enabled() || ((sp?.enabled ?? true) && !!sp?.showTerminalTabTags)
    }

    private watchHeaderStrip (headers: HTMLElement[]): void {
        const strip = this.needsHeaders() ? headers[0]?.parentElement : undefined
        if (strip === this.observedStrip) {
            return
        }
        this.observer?.disconnect()
        this.observer = undefined
        this.observedStrip = strip ?? undefined
        if (strip) {
            this.zone.runOutsideAngular(() => {
                this.observer = new MutationObserver(() => this.schedule())
                // Only direct header insertion/removal. Terminal output and chip updates are outside this scope.
                this.observer.observe(strip, { childList: true })
            })
        }
    }

    private schedule (): void {
        if ((!this.needsHeaders() && !this.applied) || this.pending !== undefined) {
            return
        }
        // Neither scheduling nor native header decoration should trigger a full Angular application tick.
        this.zone.runOutsideAngular(() => {
            this.pending = setTimeout(() => {
                this.pending = undefined
                this.sync()
            }, 0)
        })
    }

    private syncHeaderTags (headers: HTMLElement[]): void {
        const sp = this.config.store.sidebarPlus
        const enabled = (sp?.enabled ?? true) && !!sp?.showTerminalTabTags
        const paired = headers.length === this.app.tabs.length
        headers.forEach((header, index) => {
            const existing = header.querySelector('.sidebar-plus-terminal-tags')
            if (!enabled || !paired) {
                existing?.remove()
                header.classList.remove('sidebar-plus-has-tags')
                return
            }
            const tags = [...new Set(this.panes(this.app.tabs[index]).flatMap(pane => {
                const id = (pane as BaseTabComponent & { profile?: PartialProfile<Profile> }).profile?.id
                return id ? (sp.profileTags?.[id] ?? []) as string[] : []
            }))]
            if (!tags.length) {
                existing?.remove()
                header.classList.remove('sidebar-plus-has-tags')
                return
            }
            header.classList.toggle('sidebar-plus-has-tags', true)
            const signature = JSON.stringify(tags)
            if (existing?.getAttribute('data-tags') === signature) {
                return
            }
            existing?.remove()
            const rail = document.createElement('span')
            rail.className = 'sidebar-plus-terminal-tags'
            rail.setAttribute('data-tags', signature)
            rail.title = tags.join(', ')
            for (const tag of tags) {
                const chip = document.createElement('span')
                chip.className = 'sidebar-plus-terminal-tag'
                chip.textContent = tag
                chip.style.color = profileTagColor(tag)
                chip.style.backgroundColor = profileTagBackground(tag)
                rail.appendChild(chip)
            }
            header.insertBefore(rail, header.querySelector('.buttons'))
        })
    }

    private sync (): void {
        const direction = this.navigationDirection
        this.navigationDirection = 0
        const headers = Array.from(document.querySelectorAll<HTMLElement>('tab-header'))
        this.watchHeaderStrip(headers)
        this.applied = this.needsHeaders()
        this.syncHeaderTags(headers)
        for (const tab of this.app.tabs) {
            if (!this.owners.has(tab)) {
                this.owners.set(tab, this.profileOwner(tab) ?? this.currentWorkspace())
            }
        }
        if (!this.enabled()) {
            headers.forEach(h => h.classList.remove(HIDDEN_CLASS))
            return
        }
        // Tabby's tab-header ngFor follows app.tabs. Fail open if a host update changes this contract.
        if (headers.length !== this.app.tabs.length) {
            headers.forEach(h => h.classList.remove(HIDDEN_CLASS))
            return
        }
        const visible = this.app.tabs.filter(tab => this.visible(tab))
        headers.forEach((header, index) => header.classList.toggle(HIDDEN_CLASS, !visible.includes(this.app.tabs[index])))
        const active = this.app.activeTab
        if (active && visible.includes(active)) {
            this.lastActive.set(this.currentWorkspace(), active)
            return
        }
        const remembered = this.lastActive.get(this.currentWorkspace())
        let next = remembered && visible.includes(remembered) ? remembered : visible[0] ?? null
        if (direction && active && this.app.tabs.includes(active)) {
            const start = this.app.tabs.indexOf(active)
            for (let offset = 1; offset <= this.app.tabs.length; offset++) {
                const index = (start + direction * offset + this.app.tabs.length) % this.app.tabs.length
                const candidate = this.app.tabs[index]
                if (visible.includes(candidate)) {
                    next = candidate
                    break
                }
            }
        }
        if (next) {
            this.lastActive.set(this.currentWorkspace(), next)
        }
        if (next !== active) {
            this.changingFocus = true
            try {
                this.zone.run(() => this.app.selectTab(next))
            } finally {
                this.changingFocus = false
            }
        }
        for (const [id, tab] of this.lastActive) {
            if (!this.app.tabs.includes(tab)) {
                this.lastActive.delete(id)
            }
        }
    }

    ngOnDestroy (): void {
        this.subscription.unsubscribe()
        this.observer?.disconnect()
        if (this.pending !== undefined) {
            clearTimeout(this.pending)
        }
        document.querySelectorAll('tab-header').forEach(h => {
            h.classList.remove(HIDDEN_CLASS)
            h.classList.remove('sidebar-plus-has-tags')
            h.querySelector('.sidebar-plus-terminal-tags')?.remove()
        })
    }
}
