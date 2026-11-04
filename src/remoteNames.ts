/**
 * A name in a remote directory that nothing there occupies yet.
 *
 * The Explorer spelling — `report (2).pdf` — because that is the one users
 * already read without thinking, and because it leaves the extension at the end
 * where every other tool looks for it.
 *
 * `taken` is passed in rather than read here: the caller has just listed the
 * directory, and re-reading it per file would be one round trip per collision.
 * Names produced by this call are the caller's to add to that set, so a batch
 * of collisions does not hand two files the same new name.
 */
export function freeRemoteName (name: string, taken: Set<string>): string {
    if (!taken.has(name)) {
        return name
    }
    const dot = name.lastIndexOf('.')
    // A leading dot is a hidden file's marker, not an extension: `.bashrc` keeps
    // its whole name as the stem.
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    for (let n = 2; n < 10000; n++) {
        const candidate = `${stem} (${n})${extension}`
        if (!taken.has(candidate)) {
            return candidate
        }
    }
    return `${stem} (${Date.now()})${extension}`
}
