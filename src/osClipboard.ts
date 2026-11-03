import * as fs from 'fs'
import { electronRemote } from './electronRemote'

/**
 * Reading the local files the user copied in the OS file manager.
 *
 * Electron exposes the clipboard as a bag of named formats, and each platform
 * names "these are files" differently: Explorer puts the CF_HDROP block under
 * `FileNameW` (a UTF-16 buffer), Linux file managers put `file://` URIs under
 * `text/uri-list`, and Finder answers `public.file-url` for a single selection
 * and `NSFilenames` for several — a plist this module cannot read without a
 * parser, so on macOS only the single-file case is covered.
 *
 * Parsing is kept as standalone functions: a wrong parse here turns into
 * "upload the wrong local file", which is worth a test that needs no Electron.
 */

/** The slice of Electron's `clipboard` this module uses. */
interface ElectronClipboard {
    availableFormats: (type?: string) => string[]
    read: (format: string) => string
    readBuffer: (format: string) => Buffer
}

function electronClipboard (): ElectronClipboard|null {
    try {
        const req = (window as any).require ?? (global as any).require
        const clipboard = req?.('electron')?.clipboard
        if (clipboard) {
            return clipboard as ElectronClipboard
        }
    } catch {
        // An Electron without the renderer module: fall through to the remote.
    }
    try {
        return (electronRemote()?.clipboard ?? null) as ElectronClipboard|null
    } catch {
        return null
    }
}

/** A NUL-separated list of paths, as Explorer writes it, in whichever encoding. */
function splitNulList (text: string): string[] {
    return text.split('\u0000').map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * The `FileNameW` block Explorer writes: UTF-16LE paths, each terminated by a
 * NUL, the whole list terminated by a second one.
 */
export function parseFileNameW (buffer: Buffer): string[] {
    return splitNulList(buffer.toString('utf16le'))
}

/** The `text/uri-list` block Linux file managers write: one `file://` URI per line, `#` starts a comment. */
export function parseUriList (text: string): string[] {
    const paths: string[] = []
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) {
            continue
        }
        const path = localPathFromUri(trimmed)
        if (path) {
            paths.push(path)
        }
    }
    return paths
}

/** A `file://` URI as a local path, or null for anything else. */
export function localPathFromUri (value: string): string|null {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return null
    }
    if (url.protocol !== 'file:') {
        return null
    }
    // `decodeURIComponent`, not `url.pathname`: the pathname keeps `%20` for
    // spaces, and an encoded path is not what `fs` or SFTP is handed.
    try {
        const pathname = decodeURIComponent(url.pathname)
        // `file:///C:/dir` — the leading slash is not part of a Windows path.
        return /^\/[a-zA-Z]:/.test(pathname) ? pathname.slice(1) : pathname
    } catch {
        return null
    }
}

/**
 * The local files on the clipboard right now, filtered to paths that still
 * exist. Empty when the clipboard holds files from elsewhere (a text copy, a
 * web page, a format this module does not know).
 */
export function readOsFilePaths (): string[] {
    const clipboard = electronClipboard()
    if (!clipboard) {
        return []
    }
    const candidates = collect(clipboard)
    // Stale entries are normal: a file copied and deleted since, or a mount
    // that went away. Uploading a path that is not there can only fail later,
    // with a worse message.
    return candidates.filter(path => {
        try {
            return !!path && fs.existsSync(path)
        } catch {
            return false
        }
    })
}

/**
 * Tries each format in turn rather than asking `availableFormats()` first.
 *
 * Chromium does not list every format it can still read — `FileNameW`, the name
 * Explorer's file list shows up under on Windows, is the usual example — and a
 * failed read is a cheap exception to swallow, unlike a file the user pasted
 * and never saw uploaded.
 */
function collect (clipboard: ElectronClipboard): string[] {
    for (const format of ['FileNameW', 'FileName', 'text/uri-list', 'public.file-url']) {
        try {
            if (format === 'FileNameW' || format === 'FileName') {
                const buffer = clipboard.readBuffer(format)
                if (!buffer || !buffer.length) {
                    continue
                }
                // `FileName` is the ANSI twin of `FileNameW`, written by older
                // applications; non-ASCII names come through mangled, which is
                // what that format has always done.
                const paths = splitNulList(buffer.toString(format === 'FileNameW' ? 'utf16le' : 'latin1'))
                if (paths.length) {
                    return paths
                }
                continue
            }
            const text = clipboard.read(format)
            const paths = text ? parseUriList(text) : []
            if (paths.length) {
                return paths
            }
        } catch {
            // Format not on this clipboard, or not readable here: try the next.
        }
    }
    return []
}
