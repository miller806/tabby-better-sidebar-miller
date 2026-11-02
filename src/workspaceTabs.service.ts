import { SidebarPlusI18nService } from './i18n'
import { profileTagColor, profileTagBackground } from './profileTags'
import { Injectable, NgZone, OnDestroy } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, PartialProfile, Profile } from 'tabby-core'
import { Subscription } from 'rxjs'

const HIDDEN_CLASS = 'sidebar-plus-workspace-tab-hidden'

/** Filters headers without removing tabs from Tabby: recovery, shutdown and sessions keep all tabs. */
@Injectable({ providedIn: 'root' })
export class SidebarPlusWorkspaceTabsService implements OnDestroy {
    private workspaceId = window.localStorage.sidebarPlusActiveWorkspace ?? 'all'
    /** Workspace each tab was opened in: the fallback when its profile or folder claims none. */
    private owners = new WeakMap<BaseTabComponent, string>()
    /**
     * Session → workspace records from the last run, in tab order. Keyed by the
     * profiles behind a tab, which is all that survives recovery: two sessions of the
     * same profile are told apart by their position, never by the profile alone.
     */
    private saved?: { key: string, workspace: string }[]
    private restoreCursor = 0
    private restoreDrifted = false
    private restoreAttempted = new WeakSet<BaseTabComponent>()
    private written?: string
    private lastActive = new Map<string, BaseTabComponent>()
    private subscription = new Subscription()
    private observer?: MutationObserver
    private pending?: ReturnType<typeof setTimeout>
    private changingFocus = false
    private navigationDirection = 0
    private observedStrip?: Element
    private applied = false
    private dragging = false
    private interacted = false
    private revealActive = false
    private resizeObserver?: ResizeObserver
    private navigation?: { strip: HTMLElement, previous: HTMLButtonElement, next: HTMLButtonElement, update: () => void }

    visibilityRevision = 0

    constructor (private app: AppService, private config: ConfigService, private zone: NgZone, private i18n: SidebarPlusI18nService) {
        this.subscription.add(this.app.ready$.subscribe(() => {
            this.subscription.add(this.app.tabOpened$.subscribe(tab => {
                this.claimOpened(tab)
                this.visibilityRevision++
                this.revealActive = true
                this.schedule()
            }))
            this.subscription.add(this.app.tabsChanged$.subscribe(() => { this.visibilityRevision++; this.schedule() }))
            // Older Tabby hosts have no drag stream: keep decorating in that case.
            if (this.app.tabDragActive$) {
                this.subscription.add(this.app.tabDragActive$.subscribe(tab => {
                    this.dragging = !!tab
                    if (this.dragging && this.pending !== undefined) {
                        clearTimeout(this.pending)
                        this.pending = undefined
                    }
                    if (!this.dragging) {
                        this.revealActive = true
                        this.schedule()
                    }
                }))
            }
            this.subscription.add(this.app.activeTabChange$.subscribe(tab => {
                if (this.changingFocus) {
                    return
                }
                this.revealActive = true
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
            this.listenForInteraction()
            this.listenForShutdown()
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
        this.revealActive = true
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
        // Older configurations express ownership by hiding a folder/profile in
        // every other workspace. Use the same ancestor exclusions as the tree,
        // before trusting a session's previously learned (possibly wrong) owner.
        const inferred = this.panes(tab).map(pane => {
            const sessionProfile = (pane as BaseTabComponent & { profile?: PartialProfile<Profile> }).profile
            if (!sessionProfile) {
                return undefined
            }
            const profile = (sessionProfile.id ? this.config.store.profiles?.find((p: Profile) => p.id === sessionProfile.id) : undefined) ?? sessionProfile
            const ancestors = new Set<string>()
            let groupId = profile.group
            while (groupId && !ancestors.has(groupId)) {
                ancestors.add(groupId)
                groupId = this.config.store.groups?.find((g: { id: string }) => g.id === groupId)?.parentGroupId
            }
            const candidates = (sp?.workspaces ?? []).filter((workspace: {
                id: string, hiddenProfileIds?: string[], hiddenGroupIds?: string[],
            }) => !workspace.hiddenProfileIds?.includes(profile.id)
                && !workspace.hiddenGroupIds?.some(id => ancestors.has(id)))
            return candidates.length === 1 ? candidates[0].id as string : undefined
        })
        // A mixed split remains a single tab; do not infer ownership from one pane.
        return inferred.length && inferred[0] && inferred.every(owner => owner === inferred[0]) ? inferred[0] : undefined
    }

    private visible (tab: BaseTabComponent): boolean {
        const workspace = this.currentWorkspace()
        if (!this.enabled() || workspace === 'all') {
            return true
        }
        // Settings and other tools stay accessible in every workspace.
        if (!this.hasProfile(tab)) {
            return true
        }
        // Never claim a tab merely because it is being looked at: recovery attaches
        // profiles asynchronously, and a restored session must not adopt whichever
        // workspace happens to be selected when the sidebar first draws.
        const owner = this.owner(tab)
        return !owner || owner === workspace
    }

    /** Workspace a tab belongs to, or undefined when nothing ties it to one. */
    private owner (tab: BaseTabComponent): string|undefined {
        // Configured ownership wins, so moving a profile between workspaces applies at once.
        const configured = this.profileOwner(tab)
        if (configured) {
            // A deleted workspace must not leave running sessions unreachable.
            return this.workspaceExists(configured) ? configured : undefined
        }
        const learned = this.owners.get(tab)
        if (learned) {
            if (!this.workspaceExists(learned)) {
                this.owners.delete(tab)
                return undefined
            }
            return learned
        }
        if (this.interacted) {
            return undefined
        }
        // `null` means the session was recorded without a workspace and must stay unowned.
        const restored = this.takeRestored(tab)
        if (restored) {
            this.owners.set(tab, restored)
        }
        return restored ?? undefined
    }

    /**
     * A tab the user opens belongs to the workspace they are in, unless its profile
     * or folder already says otherwise; the association is stored so that the same
     * session comes back to the same workspace after a restart.
     */
    private claimOpened (tab: BaseTabComponent): void {
        if (!this.enabled() || this.profileOwner(tab)) {
            return
        }
        if (!this.interacted) {
            const restored = this.takeRestored(tab)
            if (restored !== undefined) {
                if (restored) {
                    this.owners.set(tab, restored)
                }
                return
            }
        }
        const workspace = this.currentWorkspace()
        if (workspace !== 'all') {
            this.owners.set(tab, workspace)
        }
    }

    /** Recovery ends when the user first touches the window: that is a user-opened tab. */
    private listenForInteraction (): void {
        if (typeof document.addEventListener !== 'function') {
            return
        }
        this.zone.runOutsideAngular(() => {
            document.addEventListener('pointerdown', this.markInteracted, true)
            document.addEventListener('keydown', this.markInteracted, true)
        })
    }

    private markInteracted = (): void => {
        this.interacted = true
        document.removeEventListener('pointerdown', this.markInteracted, true)
        document.removeEventListener('keydown', this.markInteracted, true)
    }

    /** A restored session closed before its profile is ready would otherwise leave no record. */
    private listenForShutdown (): void {
        if (typeof window.addEventListener !== 'function') {
            return
        }
        this.zone.runOutsideAngular(() => window.addEventListener('beforeunload', this.flushOwners))
    }

    private flushOwners = (): void => {
        this.writeOwners()
    }

    private hasProfile (tab: BaseTabComponent): boolean {
        return this.panes(tab).some(pane => !!(pane as BaseTabComponent & { profile?: unknown }).profile)
    }

    private workspaceExists (id: string): boolean {
        return !!this.config.store.sidebarPlus?.workspaces?.some((w: { id: string }) => w.id === id)
    }

    /** Durable identity of a session: the profiles behind its panes. */
    private sessionKey (tab: BaseTabComponent): string|undefined {
        const ids = this.panes(tab)
            .map(pane => (pane as BaseTabComponent & { profile?: PartialProfile<Profile> }).profile?.id)
            .filter(id => !!id)
        return ids.length ? ids.join('+') : undefined
    }

    /**
     * The workspace recorded for this session on the previous run. Tabby recovers the
     * saved tabs in the order they had, so position tells apart the sessions that
     * share a profile, and a tab that failed to recover only shifts the cursor until
     * the next matching key. Sessions whose pane has no profile id are matched by
     * position alone, which is why they are only ever taken in order.
     */
    private takeRestored (tab: BaseTabComponent): string|null|undefined {
        if (this.restoreAttempted.has(tab)) {
            return undefined
        }
        const key = this.sessionKey(tab)
        const saved = this.savedOwners()
        const entry = saved[this.restoreCursor]
        if (entry && entry.key === (key ?? '')) {
            this.restoreAttempted.add(tab)
            this.restoreCursor++
            return entry.workspace && this.workspaceExists(entry.workspace) ? entry.workspace : null
        }
        if (!key) {
            // Recovery attaches the profile after the tab opens: try again on the next pass.
            return undefined
        }
        this.restoreAttempted.add(tab)
        if (this.restoreDrifted) {
            return undefined
        }
        // A tab that failed to recover, or one opened before this version: resynchronise
        // on the next entry carrying the same profile and stop trusting positions.
        for (let index = this.restoreCursor; index < saved.length; index++) {
            if (saved[index].key === key) {
                this.restoreCursor = index + 1
                this.restoreDrifted = true
                const workspace = saved[index].workspace
                return workspace && this.workspaceExists(workspace) ? workspace : null
            }
        }
        return undefined
    }

    private savedOwners (): { key: string, workspace: string }[] {
        if (!this.saved) {
            this.saved = []
            try {
                const parsed = JSON.parse(window.localStorage.sidebarPlusSessionOwners ?? '[]')
                if (Array.isArray(parsed)) {
                    this.saved = parsed
                        .filter(entry => entry && typeof entry.key === 'string' && typeof entry.workspace === 'string')
                        .map(entry => ({ key: entry.key, workspace: entry.workspace }))
                }
            } catch {
                // Unreadable, or written by an older version: start over, sessions stay reachable.
            }
        }
        return this.saved
    }

    /** Records where every open tab belongs, in tab order, for the next start. */
    private writeOwners (): void {
        if (!this.enabled()) {
            return
        }
        const entries = this.app.tabs.map(tab => ({ key: this.sessionKey(tab) ?? '', workspace: this.owner(tab) ?? '' }))
        const serialized = JSON.stringify(entries)
        if (serialized === this.written) {
            return
        }
        this.written = serialized
        this.saved = entries
        try {
            window.localStorage.sidebarPlusSessionOwners = serialized
        } catch {
            // A full or disabled localStorage costs the association, never the session.
        }
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
        this.resizeObserver?.disconnect()
        this.removeNavigation()
        this.observer = undefined
        this.observedStrip = strip ?? undefined
        if (strip) {
            this.zone.runOutsideAngular(() => {
                this.observer = new MutationObserver(() => this.schedule())
                // Only direct header insertion/removal. Terminal output and chip updates are outside this scope.
                this.observer.observe(strip, { childList: true })
                this.installNavigation(strip as HTMLElement)
                this.resizeObserver = new ResizeObserver(() => {
                    this.revealActive = true
                    this.schedule()
                })
                this.resizeObserver.observe(strip)
            })
        }
    }

    private schedule (): void {
        if (this.dragging || (!this.needsHeaders() && !this.applied) || this.pending !== undefined) {
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

    private removeNavigation (): void {
        if (!this.navigation) {
            return
        }
        const { strip, previous, next, update } = this.navigation
        strip.removeEventListener('scroll', update)
        previous.remove()
        next.remove()
        this.navigation = undefined
    }

    private installNavigation (strip: HTMLElement): void {
        const parent = strip.parentElement
        if (!parent) {
            return
        }
        const previous = document.createElement('button')
        const next = document.createElement('button')
        previous.className = next.className = 'sidebar-plus-tab-scroll'
        previous.type = next.type = 'button'
        previous.textContent = '‹'
        next.textContent = '›'
        previous.setAttribute('aria-label', this.i18n.t('Scroll tabs backward'))
        next.setAttribute('aria-label', this.i18n.t('Scroll tabs forward'))
        const vertical = (): boolean => !!strip.closest('.tabs-on-left, .tabs-on-right')
        const move = (direction: number): void => {
            if (vertical()) {
                strip.scrollTop += direction * Math.max(100, strip.clientHeight * .7)
            } else {
                strip.scrollLeft += direction * Math.max(100, strip.clientWidth * .7)
            }
        }
        previous.addEventListener('click', () => move(-1))
        next.addEventListener('click', () => move(1))
        const update = (): void => {
            const overflow = !vertical() && strip.scrollWidth > strip.clientWidth + 1
            previous.hidden = next.hidden = !overflow
            previous.disabled = strip.scrollLeft <= 1
            next.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1
        }
        parent.insertBefore(previous, strip)
        parent.insertBefore(next, strip.nextSibling)
        strip.addEventListener('scroll', update, { passive: true })
        this.navigation = { strip, previous, next, update }
        update()
    }

    private revealSelectedHeader (headers: HTMLElement[]): void {
        this.navigation?.update()
        if (!this.revealActive || this.dragging) {
            return
        }
        const index = this.app.activeTab ? this.app.tabs.indexOf(this.app.activeTab) : -1
        const header = headers[index]
        const strip = header?.parentElement
        if (!header || !strip) {
            return
        }
        this.revealActive = false
        const box = header.getBoundingClientRect()
        const viewport = strip.getBoundingClientRect()
        if (strip.closest('.tabs-on-left, .tabs-on-right')) {
            if (box.top < viewport.top) strip.scrollTop -= viewport.top - box.top
            else if (box.bottom > viewport.bottom) strip.scrollTop += box.bottom - viewport.bottom
        } else {
            if (box.left < viewport.left) strip.scrollLeft -= viewport.left - box.left
            else if (box.right > viewport.right) strip.scrollLeft += box.right - viewport.right
        }
        this.navigation?.update()
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
        if (this.dragging) {
            return
        }
        const direction = this.navigationDirection
        this.navigationDirection = 0
        const headers = Array.from(document.querySelectorAll<HTMLElement>('.tab-bar > .tabs > tab-header:not(.cdk-drag-preview)'))
        this.watchHeaderStrip(headers)
        this.applied = this.needsHeaders()
        if (this.interacted) {
            // Records where each session belongs for the next start; see takeRestored().
            // Written before the header checks below, which may bail out on a transient DOM mismatch.
            this.writeOwners()
        }
        // Native open/close animations can temporarily leave a different number of headers.
        // Never assign tags by index until the DOM and app.tabs agree again.
        if (headers.length !== this.app.tabs.length) {
            headers.forEach(h => h.classList.remove(HIDDEN_CLASS))
            return
        }
        this.syncHeaderTags(headers)
        if (!this.enabled()) {
            headers.forEach(h => h.classList.remove(HIDDEN_CLASS))
            this.revealSelectedHeader(headers)
            return
        }
        const visible = this.app.tabs.filter(tab => this.visible(tab))
        headers.forEach((header, index) => header.classList.toggle(HIDDEN_CLASS, !visible.includes(this.app.tabs[index])))
        const active = this.app.activeTab
        if (active && visible.includes(active)) {
            this.lastActive.set(this.currentWorkspace(), active)
            this.revealSelectedHeader(headers)
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
                this.revealActive = true
            } finally {
                this.changingFocus = false
            }
        }
        this.revealSelectedHeader(headers)
        for (const [id, tab] of this.lastActive) {
            if (!this.app.tabs.includes(tab)) {
                this.lastActive.delete(id)
            }
        }
    }

    ngOnDestroy (): void {
        this.subscription.unsubscribe()
        this.observer?.disconnect()
        this.resizeObserver?.disconnect()
        this.removeNavigation()
        if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('pointerdown', this.markInteracted, true)
            document.removeEventListener('keydown', this.markInteracted, true)
        }
        if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('beforeunload', this.flushOwners)
        }
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
