export const mailTags = [
  { id: 1, name: "Wichtig", color: "Rot" },
  { id: 2, name: "Arbeit", color: "Orange" },
  { id: 3, name: "Persönlich", color: "Grün" },
  { id: 4, name: "Zu erledigen", color: "Blau" },
] as const;

export function toggleTag(tags: number[], tag: number): number[] {
  if (tag === 0) return [];
  return tags.includes(tag)
    ? tags.filter((id) => id !== tag)
    : [...tags, tag].sort((a, b) => a - b);
}

export function tagShortcut(event: KeyboardEvent): number | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    !/^[0-4]$/.test(event.key)
  )
    return null;
  if (
    event.target instanceof Element &&
    event.target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    )
  )
    return null;
  return Number(event.key);
}
