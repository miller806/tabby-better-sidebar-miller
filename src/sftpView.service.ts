import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

/** Where the SFTP view is rendered. */
export type SftpPlacement = 'sidebar' | 'right'

/**
 * Where the SFTP view lives, and whether it is showing.
 *
 * State rather than a flag on the tree component, because the view has two
 * possible hosts — the sidebar it used to replace, or a full-height dock at the
 * right of the window — and only one of them may exist at a time: behind it
 * sits a cache of one panel per SSH tab, and each panel opens an SFTP channel
 * that never closes on its own. Both hosts read the same flag from here.
 *
 * Mutable fields, not observables: every writer is a click or a hotkey, which
 * runs inside the Angular zone, so a change detection pass follows on its own.
 */
@Injectable({ providedIn: 'root' })
export class SidebarPlusSftpViewService {
    visible = false

    constructor (private config: ConfigService) { }

    /**
     * `right` unless the configuration says otherwise — and also when it says
     * nothing at all, which is the case for every configuration written before
     * this setting existed. The dock is the placement that gives a file table
     * the room a file table needs.
     */
    get placement (): SftpPlacement {
        return this.config.store.sidebarPlus?.sftpPlacement === 'sidebar' ? 'sidebar' : 'right'
    }

    get inDock (): boolean {
        return this.placement === 'right'
    }

    show (): void {
        this.visible = true
    }

    hide (): void {
        this.visible = false
    }

    toggle (): void {
        this.visible = !this.visible
    }
}
