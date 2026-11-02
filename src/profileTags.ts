/** Shared palette for profile rows and native terminal headers. */
export function profileTagColor (tag: string): string {
    let hash = 0
    for (const char of tag) {
        hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
    }
    return `hsl(${((hash % 360) + 360) % 360}, 72%, 72%)`
}

export function profileTagBackground (tag: string): string {
    return profileTagColor(tag).replace('hsl(', 'hsla(').replace(')', ', 0.12)')
}
