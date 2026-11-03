import { Injectable } from '@angular/core'
import { SFTPPanelComponent } from 'tabby-ssh'

/** The live SFTP transport, borrowed from the one member that publicly exposes its type. */
type SftpSession = SFTPPanelComponent['sftp']

/**
 * One entry remembered by the SFTP clipboard: what a paste needs to know, and
 * nothing that would go stale in the meantime (no size to report, no icon).
 */
export interface SftpClipboardEntry {
    name: string
    path: string
    isDirectory: boolean
    size: number
    mode: number
}

/** Why an entry cannot land where it was pasted. */
export type PasteRejection = 'inside' | 'exists'

export interface PastePlan {
    /** Entries to send through a download + upload round trip. */
    transfer: SftpClipboardEntry[]
    /** Entries to rename in place — a cut pasted back into the session it came from. */
    move: SftpClipboardEntry[]
    /** Entries the destination refuses, with the reason, so the caller can say which and why. */
    rejected: { entry: SftpClipboardEntry, reason: PasteRejection }[]
}

/**
 * Whether `candidate` is `ancestor` itself or lives underneath it.
 *
 * The separator matters: without it `/tmp/ab` would read as being inside
 * `/tmp/a`. A move or copy judged this way is one that would make a directory
 * its own ancestor — the server sometimes accepts the `rename`, and a
 * copy that starts walking its own output never ends.
 */
export function isPathInside (ancestor: string, candidate: string): boolean {
    return candidate === ancestor || candidate.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`)
}

/**
 * Decides what a paste does with each entry, before anything touches the
 * server.
 *
 * Deliberately pure: the caller owns listing the destination and doing the
 * work, which is what keeps the decision — the part that silently destroys
 * files when it is wrong — testable without an SFTP session.
 *
 * A cut within the session the entries came from is a rename: instant, no
 * bytes moved. Everything else is a transfer, including a cut across two
 * sessions, where the source files are deleted only once their copy landed.
 * A name already present in the destination is refused rather than
 * overwritten, exactly as the drag-move and rename paths do.
 */
export function planPaste (options: {
    entries: SftpClipboardEntry[]
    destination: string
    existingNames: string[]
    sameSession: boolean
    cut: boolean
}): PastePlan {
    const existing = new Set(options.existingNames)
    const plan: PastePlan = { transfer: [], move: [], rejected: [] }
    for (const entry of options.entries) {
        if (isPathInside(entry.path, options.destination)) {
            plan.rejected.push({ entry, reason: 'inside' })
            continue
        }
        if (existing.has(entry.name)) {
            plan.rejected.push({ entry, reason: 'exists' })
            continue
        }
        if (options.cut && options.sameSession) {
            plan.move.push(entry)
        } else {
            plan.transfer.push(entry)
        }
    }
    return plan
}

/**
 * The file clipboard, shared by every SFTP panel.
 *
 * App-wide on purpose: copying from one panel and pasting into another is the
 * whole point, and a panel is torn down and rebuilt whenever the sidebar
 * switches tabs. The source session is kept as an opaque reference rather than
 * an id — the only question ever asked of it is whether the paste lands in the
 * same session, which is what decides between a rename and a real transfer.
 */
@Injectable({ providedIn: 'root' })
export class SidebarPlusSftpClipboardService {
    entries: SftpClipboardEntry[] = []
    cut = false
    /** Session the entries were copied from; a paste into it is a rename rather than a transfer. */
    sourceSession: SftpSession|null = null

    /** Whether a paste has anything to work with. */
    get hasEntries (): boolean {
        return this.entries.length > 0
    }

    get count (): number {
        return this.entries.length
    }

    set (entries: SftpClipboardEntry[], cut: boolean, source: SftpSession|null): void {
        this.entries = entries
        this.cut = cut
        this.sourceSession = source
    }

    /** Whether the clipboard was filled from this very session — the condition for a cut to be a rename. */
    isFrom (source: SftpSession): boolean {
        return this.sourceSession !== null && this.sourceSession === source
    }

    /** Emptied after a successful cut, so a second paste cannot move what is no longer there. */
    clear (): void {
        this.entries = []
        this.cut = false
        this.sourceSession = null
    }
}
