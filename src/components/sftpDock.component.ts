import './sftpDock.component.scss'
import { Component, HostBinding, HostListener } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { SidebarPlusSftpViewService } from '../sftpView.service'

/** Narrow enough for a name column, wide enough for size and date beside it. */
const MIN_WIDTH = 320
/** Past this a file table stops gaining and starts eating the terminal. */
const MAX_WIDTH = 960
const DEFAULT_WIDTH = 460
/** Never let the dock take more than this share of the window, whatever the drag says. */
const MAX_WINDOW_SHARE = 0.7

const WIDTH_KEY = 'sidebarPlusSftpDockWidth'

/**
 * The SFTP view as a full-height column at the right of the window, beside a
 * sidebar that keeps the profile tree.
 *
 * Mounted by `SidebarPlusMountService` as the last child of Tabby's own
 * `.window` flex row — the same trick the sidebar uses at the front of it. The
 * panel inside is `SidebarPlusSftpComponent`, unchanged: it caches one panel per
 * SSH tab and that cache must survive collapsing the dock, so the element is
 * hidden rather than destroyed.
 */
@Component({
    selector: 'sidebar-plus-sftp-dock',
    template: require('./sftpDock.component.pug'),
})
export class SidebarPlusSftpDockComponent {
    constructor (private view: SidebarPlusSftpViewService, private config: ConfigService) { }

    /** Same rule as the sidebar's own `showTransfers`: the panel has to be on, and its transfer block too. */
    get showTransfers (): boolean {
        const sp = this.config.store.sidebarPlus
        return (sp?.showSftp ?? true) && (sp?.showTransfers ?? true)
    }

    get visible (): boolean {
        return this.view.visible
    }

    hide (): void {
        this.view.hide()
    }

    /**
     * Collapsed means `display: none`, not `*ngIf`: destroying the component
     * would destroy its panel cache with it, and rebuilding one opens a fresh
     * SFTP channel that nothing ever closes. It also takes the dock out of the
     * flex row, so the terminal area gets the width back immediately.
     */
    @HostBinding('style.display')
    get display (): string {
        return this.visible ? 'flex' : 'none'
    }

    @HostBinding('style.width.px')
    width = Math.min(SidebarPlusSftpDockComponent.readWidth(), SidebarPlusSftpDockComponent.windowCap())

    /** A window resized smaller must not leave a dock wider than the room it has. */
    @HostListener('window:resize')
    onWindowResize (): void {
        this.width = Math.min(this.width, SidebarPlusSftpDockComponent.windowCap())
    }

    private static windowCap (): number {
        return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(window.innerWidth * MAX_WINDOW_SHARE)))
    }

    private resizing = false
    private startX = 0
    private startWidth = 0
    private saveTimer: ReturnType<typeof setTimeout>|null = null

    private static readWidth (): number {
        const raw = parseInt(window.localStorage[WIDTH_KEY] ?? '', 10)
        return Number.isFinite(raw) ? Math.min(Math.max(raw, MIN_WIDTH), MAX_WIDTH) : DEFAULT_WIDTH
    }

    startResize (event: MouseEvent): void {
        this.resizing = true
        this.startX = event.clientX
        this.startWidth = this.width
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.resizing) {
            return
        }
        // The rail is on the dock's left edge, so dragging left widens it.
        const wanted = this.startWidth - (event.clientX - this.startX)
        this.width = Math.min(Math.max(wanted, MIN_WIDTH), SidebarPlusSftpDockComponent.windowCap())
        // Same reasoning as the sidebar's own resize: a synchronous localStorage
        // write per pointer move is what makes a drag judder.
        this.scheduleSave()
    }

    @HostListener('document:mouseup')
    stopResize (): void {
        if (!this.resizing) {
            return
        }
        this.resizing = false
        this.flushSave()
    }

    private scheduleSave (): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer)
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null
            window.localStorage[WIDTH_KEY] = this.width.toString()
        }, 250)
    }

    private flushSave (): void {
        if (!this.saveTimer) {
            return
        }
        clearTimeout(this.saveTimer)
        this.saveTimer = null
        window.localStorage[WIDTH_KEY] = this.width.toString()
    }
}
