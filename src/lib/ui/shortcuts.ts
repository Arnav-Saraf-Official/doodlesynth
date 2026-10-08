/**
 * Keyboard shortcuts.
 *
 * One table drives both dispatch and the in-app shortcut panel, so the
 * documentation cannot drift from the behaviour.
 */

export interface ShortcutDefinition {
	id: string;
	/** canonical chord, e.g. 'Mod+Shift+Z' */
	keys: string;
	label: string;
	description: string;
	group: 'Transport' | 'Tools' | 'Edit' | 'View' | 'Tracks' | 'Points';
}

export const SHORTCUTS: ShortcutDefinition[] = [
	{ id: 'play', keys: 'Space', label: 'Space', description: 'Play / pause', group: 'Transport' },
	{
		id: 'stop',
		keys: 'Mod+.',
		label: '⌘/.',
		description: 'Stop and return to start',
		group: 'Transport'
	},
	{
		id: 'home',
		keys: 'Home',
		label: 'Home',
		description: 'Go to project start',
		group: 'Transport'
	},
	{ id: 'end', keys: 'End', label: 'End', description: 'Go to last content', group: 'Transport' },

	{ id: 'tool-select', keys: 'A', label: 'A', description: 'Select tool', group: 'Tools' },
	{ id: 'tool-draw', keys: 'P', label: 'P', description: 'Pen / draw tool', group: 'Tools' },
	{ id: 'tool-erase', keys: 'E', label: 'E', description: 'Eraser', group: 'Tools' },
	{ id: 'tool-split', keys: 'S', label: 'S', description: 'Split curve', group: 'Tools' },
	{ id: 'tool-pan', keys: 'H', label: 'H', description: 'Pan', group: 'Tools' },

	{ id: 'undo', keys: 'Mod+Z', label: '⌘Z', description: 'Undo', group: 'Edit' },
	{ id: 'redo', keys: 'Mod+Shift+Z', label: '⌘⇧Z', description: 'Redo', group: 'Edit' },
	{ id: 'copy', keys: 'Mod+C', label: '⌘C', description: 'Copy selection', group: 'Edit' },
	{ id: 'paste', keys: 'Mod+V', label: '⌘V', description: 'Paste at playhead', group: 'Edit' },
	{
		id: 'duplicate',
		keys: 'Mod+D',
		label: '⌘D',
		description: 'Duplicate selection',
		group: 'Edit'
	},
	{ id: 'delete', keys: 'Delete', label: 'Del', description: 'Delete selection', group: 'Edit' },
	{
		id: 'cancel',
		keys: 'Escape',
		label: 'Esc',
		description: 'Cancel current action',
		group: 'Edit'
	},

	{ id: 'snap-toggle', keys: 'G', label: 'G', description: 'Toggle snap', group: 'View' },
	{ id: 'zoom-selection', keys: 'Z', label: 'Z', description: 'Zoom to selection', group: 'View' },
	{
		id: 'zoom-project',
		keys: 'Shift+Z',
		label: '⇧Z',
		description: 'Zoom to project',
		group: 'View'
	},
	{
		id: 'pitch-map',
		keys: 'M',
		label: 'M',
		description: 'Switch Piano / Frequency map',
		group: 'View'
	},
	{ id: 'inspector', keys: 'I', label: 'I', description: 'Toggle inspector', group: 'View' },

	{ id: 'next-track', keys: 'Tab', label: 'Tab', description: 'Next track', group: 'Tracks' },
	{
		id: 'previous-track',
		keys: 'Shift+Tab',
		label: '⇧Tab',
		description: 'Previous track',
		group: 'Tracks'
	},
	{ id: 'new-track', keys: 'Mod+T', label: '⌘T', description: 'New track', group: 'Tracks' },

	{
		id: 'snap-note',
		keys: 'N',
		label: 'N',
		description: 'Snap selected points to actual note Hz',
		group: 'Points'
	},
	{
		id: 'nudge-left',
		keys: 'ArrowLeft',
		label: '←',
		description: 'Nudge point earlier',
		group: 'Points'
	},
	{
		id: 'nudge-right',
		keys: 'ArrowRight',
		label: '→',
		description: 'Nudge point later',
		group: 'Points'
	},
	{
		id: 'nudge-up',
		keys: 'ArrowUp',
		label: '↑',
		description: 'Nudge point up in pitch',
		group: 'Points'
	},
	{
		id: 'nudge-down',
		keys: 'ArrowDown',
		label: '↓',
		description: 'Nudge point down in pitch',
		group: 'Points'
	}
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Split a chord into its normalized parts. */
export function parseShortcut(keys: string): {
	key: string;
	shift: boolean;
	alt: boolean;
	mod: boolean;
} {
	const parts = keys.split('+');
	let key = '';
	let shift = false;
	let alt = false;
	let mod = false;
	for (const part of parts) {
		const lower = part.toLowerCase();
		if (lower === 'shift') shift = true;
		else if (lower === 'alt') alt = true;
		else if (lower === 'mod') mod = true;
		else key = part;
	}
	return { key, shift, alt, mod };
}

export function matchesShortcut(event: KeyboardEvent, keys: string): boolean {
	const parsed = parseShortcut(keys);
	const primary = isMac ? event.metaKey : event.ctrlKey;
	if (parsed.mod !== (primary || (isMac ? event.ctrlKey : event.metaKey))) return false;
	if (parsed.shift !== event.shiftKey) return false;
	if (parsed.alt !== event.altKey) return false;
	const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;
	const target = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
	return eventKey === target;
}

/** True when typing would go into a text field rather than the editor. */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Dispatch a key event against a handler map keyed by shortcut id.
 * Returns true when a handler ran, so callers can stop the event.
 */
export function dispatchShortcut(
	event: KeyboardEvent,
	handlers: Partial<Record<string, () => void>>
): boolean {
	for (const shortcut of SHORTCUTS) {
		const handler = handlers[shortcut.id];
		if (!handler) continue;
		if (matchesShortcut(event, shortcut.keys)) {
			event.preventDefault();
			handler();
			return true;
		}
	}
	return false;
}

export function shortcutsByGroup(): { group: string; items: ShortcutDefinition[] }[] {
	const groups = new Map<string, ShortcutDefinition[]>();
	for (const shortcut of SHORTCUTS) {
		const list = groups.get(shortcut.group) ?? [];
		list.push(shortcut);
		groups.set(shortcut.group, list);
	}
	return [...groups.entries()].map(([group, items]) => ({ group, items }));
}
