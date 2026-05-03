export function parseCommandArgs(text: string | undefined): string[] {
    if (!text) return [];
    return text.trim().split(/\s+/).slice(1);
}

export function stripAt(username: string): string {
    return username.startsWith('@') ? username.slice(1) : username;
}
