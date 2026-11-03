import './hostChrome.scss'
import { ApplicationRef, ComponentRef, EnvironmentInjector, Injectable, createComponent } from '@angular/core'
import { AppService, ConfigService, NotificationsService } from 'tabby-core'
import { SidebarPlusTreeComponent } from './components/sidebarTree.component'
import { SidebarPlusSftpDockComponent } from './components/sftpDock.component'
import { tabWidthSetting } from './workspaceTabs.service'
import { checkHost, hostSupports } from './hostCompat'
import { SidebarPlusI18nService } from './i18n'
import { SidebarPlusVisibilityService } from './visibility.service'

/** Set on `body` while Tabby's own transfers menu is to stay out of the way. */
const HIDE_NATIVE_TRANSFERS_CLASS = 'sidebar-plus-hide-native-transfers'

@Injectable({ providedIn: 'root' })
export class SidebarPlusMountService {
    private componentRef: ComponentRef<SidebarPlusTreeComponent>|null = null
    /** The right-hand SFTP dock, when the configuration places the view there. */
    private dockRef: ComponentRef<SidebarPlusSftpDockComponent>|null = null

    /**
     * Whether the host failed a precondition that leaves nothing to mount.
     *
     * Only the fatal verdict is kept. The per-feature detail is reported to the
     * user and to the console, but nothing consumes it programmatically yet:
     * retiring a single block (hiding the SFTP toggle when `SFTPPanelComponent`
     * is gone) needs a way to switch a block off, which is what the
     * "Interrupteurs par bloc" chantier builds. Storing the list here now would
     * be a second, unused mechanism racing the one that is coming.
     */
    private hostFatal = false

    /** Whether the sidebar has been mounted at least once in this window — see mount(). */
    private mountedBefore = false

    constructor (
        private appRef: ApplicationRef,
        private environmentInjector: EnvironmentInjector,
        private app: AppService,
        private config: ConfigService,
        private notifications: NotificationsService,
        private i18n: SidebarPlusI18nService,
        private visibility: SidebarPlusVisibilityService,
    ) {
        this.app.ready$.subscribe(() => {
            this.verifyHost()
            this.sync()
            this.config.changed$.subscribe(() => this.sync())
        })
    }

    /**
     * Checks what this plugin needs from Tabby, and says so **once**.
     *
     * Run from `ready$` rather than the constructor: one of the preconditions
     * is a DOM container, which does not exist before the host has rendered.
     * And once only — `sync()` re-runs on every `config.changed$`, so reporting
     * from there would turn a broken host into a stream of toasts.
     */
    private verifyHost (): void {
        const report = checkHost()
        this.hostFatal = report.fatal
        if (!report.failed.length) {
            return
        }

        const lost = report.failed.map(p => this.i18n.t(p.feature.message, p.feature.params)).join(', ')
        // console.error as well as the toast: a notification is gone in
        // seconds, and this is exactly the kind of failure someone comes back
        // to diagnose later.
        console.error(
            '[tabby-better-sidebar] Contrôle de compatibilité échoué :',
            report.failed.map(p => p.id).join(', '),
            '— cette version de Tabby ne fournit plus ce que le plugin attend.',
        )
        // Pas de liste dans le cas fatal : ce qui est perdu, c'est tout, et
        // énumérer « la sidebar elle-même » entre parenthèses se lit comme une
        // restriction alors que c'en est le contraire.
        this.notifications.error(
            report.fatal
                ? this.i18n.t('tabby-better-sidebar cannot start on this version of Tabby — see the console for details')
                : this.i18n.t('tabby-better-sidebar: {lost} — unavailable on this version of Tabby', { lost }),
        )
    }

    private sync (): void {
        // A fatal precondition means there is nothing to mount into. Keep
        // unmounting reachable so the host is still left as it was found.
        const enabled = !this.hostFatal && (this.config.store.sidebarPlus?.enabled ?? true)
        if (enabled) {
            this.mount()
        } else {
            this.unmount()
        }
        // Hiding Tabby's own transfers menu is only defensible while we show
        // those transfers ourselves. Three ways that stops being true — the
        // plugin switched off, the SFTP view switched off, the panel switched
        // off — and in each of them hiding it would leave the user with *no*
        // readout of a transfer at all, including transfers started by the
        // native panel or another plugin, which our registry only ever
        // mirrored. The setting keeps its value; only its effect is suspended.
        this.syncDock(enabled)
        const sp = this.config.store.sidebarPlus
        const panelShown = (sp?.showSftp ?? true) && (sp?.showTransfers ?? true)
        const hide = enabled && panelShown && (sp?.hideNativeTransfersMenu ?? true)
        document.body.classList.toggle(HIDE_NATIVE_TRANSFERS_CLASS, hide)
        // The tab strip belongs to Tabby, and this plugin's chrome rules are
        // global CSS: a class on <body> is how they get their hands on it.
        const width = enabled ? tabWidthSetting(sp?.tabWidth) : 'default'
        document.body.classList.toggle('sidebar-plus-tabs-compact', width === 'compact')
        document.body.classList.toggle('sidebar-plus-tabs-tight', width === 'tight')
    }

    private mount (): void {
        if (this.componentRef) {
            return
        }
        const container = document.querySelector('.window.h-100.d-flex')
        if (!container) {
            // verifyHost() has already reported this as fatal, and `sync()`
            // will not have called us. Reaching here means the container went
            // away *after* startup — nothing to say twice, but never a silent
            // return either.
            console.error('[tabby-better-sidebar] Conteneur de montage introuvable, sidebar non montée.')
            return
        }
        // Switching the plugin back on in the settings is someone looking for
        // their sidebar: a hidden state left by the toggle hotkey would make
        // that switch look broken. Not on the first mount, which has to honour
        // the state the last session ended in.
        if (this.mountedBefore) {
            this.visibility.setHidden(false)
        }
        this.mountedBefore = true
        this.componentRef = createComponent(SidebarPlusTreeComponent, {
            environmentInjector: this.environmentInjector,
        })
        this.appRef.attachView(this.componentRef.hostView)
        container.insertBefore(this.rootNodeOf(this.componentRef), container.firstChild)
    }

    /**
     * Takes the sidebar back out — of the DOM as well as of Angular.
     *
     * `.remove()` is not a precaution: `ComponentRef.destroy()` does **not**
     * touch the DOM here. Angular's default DOM renderer leaves `destroyNode`
     * null, so destroying a view built by `createComponent()` and inserted by
     * hand leaves that node exactly where it was put. Switching the plugin off
     * therefore left a frozen, unresponsive sidebar on screen, and switching it
     * back on inserted a *second* one next to the corpse — the mount above only
     * checks its own reference, which had been cleared. The SFTP panel does the
     * same thing in `destroyPanel()`, for the same reason.
     */
    private unmount (): void {
        if (!this.componentRef) {
            return
        }
        this.rootNodeOf(this.componentRef).remove()
        this.appRef.detachView(this.componentRef.hostView)
        this.componentRef.destroy()
        this.componentRef = null
    }

    /**
     * Mounts or retires the right-hand SFTP dock.
     *
     * Last child of `.window.h-100.d-flex`, where the sidebar is the first: that
     * element is Tabby's own row, so a dock appended to it sits to the right of
     * everything — tab bar included — and the terminal in the middle resizes
     * itself, since its frontend observes its own host with a ResizeObserver.
     *
     * One host at a time is the rule, not an optimisation: the panel behind it
     * caches one SFTP channel per session and nothing would close a second one.
     */
    private syncDock (enabled: boolean): void {
        const sp = this.config.store.sidebarPlus
        const want = enabled
            && (sp?.sftpPlacement !== 'sidebar')
            && (sp?.showSftp ?? true)
            && hostSupports('sftp-panel')
        if (!want) {
            this.unmountDock()
            return
        }
        if (this.dockRef) {
            return
        }
        const container = document.querySelector('.window.h-100.d-flex')
        if (!container) {
            return
        }
        this.dockRef = createComponent(SidebarPlusSftpDockComponent, {
            environmentInjector: this.environmentInjector,
        })
        this.appRef.attachView(this.dockRef.hostView)
        container.appendChild(this.rootNodeOfComponent(this.dockRef))
    }

    private unmountDock (): void {
        if (!this.dockRef) {
            return
        }
        this.rootNodeOfComponent(this.dockRef).remove()
        this.appRef.detachView(this.dockRef.hostView)
        this.dockRef.destroy()
        this.dockRef = null
    }

    private rootNodeOfComponent<T> (ref: ComponentRef<T>): HTMLElement {
        return (ref.hostView as unknown as { rootNodes: HTMLElement[] }).rootNodes[0]
    }

    private rootNodeOf (ref: ComponentRef<SidebarPlusTreeComponent>): HTMLElement {
        return (ref.hostView as unknown as { rootNodes: HTMLElement[] }).rootNodes[0]
    }
}
