import { Injectable } from '@angular/core'
import { ToolbarButton, ToolbarButtonProvider } from 'tabby-core'
import { SidebarPlusSftpViewService } from './sftpView.service'
import { SidebarPlusI18nService } from './i18n'

/**
 * The panel-shaped icon in Tabby's tab bar (right group), which shows and hides
 * the SFTP view.
 *
 * A real toolbar button rather than another control inside the sidebar: with the
 * view docked at the right of the window, the thing that opens and closes it
 * belongs to the window, not to the sidebar it now sits beside. It also keeps
 * the gesture reachable while the dock is collapsed, which a button living
 * inside the dock could not do.
 */
const PANEL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
  <rect x="1" y="2" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <line x1="10" y1="2" x2="10" y2="14" stroke="currentColor" stroke-width="1.2"/>
</svg>`

@Injectable()
export class SidebarPlusSftpToolbarProvider extends ToolbarButtonProvider {
    constructor (private view: SidebarPlusSftpViewService, private i18n: SidebarPlusI18nService) {
        super()
    }

    provide (): ToolbarButton[] {
        return [{
            icon: PANEL_ICON,
            title: this.i18n.t('Toggle the SFTP panel'),
            // Left of the other right-group buttons, which carry no weight: this
            // one is a view toggle, not a settings entry.
            weight: 10,
            click: () => this.view.toggle(),
        }]
    }
}
