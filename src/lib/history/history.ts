/**
 * Undo/redo.
 *
 * Every edit is a command with an undo and a redo that swap between immutable
 * project values. Because the project is updated structurally rather than
 * mutated in place, keeping the before/after references is cheap — there is no
 * deep copy anywhere in the history path.
 *
 * Continuous gestures coalesce: a drag pushes one command, not one per frame.
 */

export interface Command {
	label: string;
	undo: () => void;
	redo: () => void;
	/** commands sharing a key within the coalesce window merge into one */
	coalesceKey?: string;
	/** wall clock of the last push, used by the coalesce window */
	timestamp: number;
}

export interface HistoryEntry {
	label: string;
}

const COALESCE_WINDOW_MS = 600;

export class HistoryManager {
	private past: Command[] = [];
	private future: Command[] = [];
	private limit: number;

	constructor(limit = 200) {
		this.limit = limit;
	}

	push(command: Omit<Command, 'timestamp'>, coalesce = false): void {
		const entry: Command = { ...command, timestamp: Date.now() };

		if (coalesce && entry.coalesceKey) {
			const previous = this.past[this.past.length - 1];
			if (
				previous &&
				previous.coalesceKey === entry.coalesceKey &&
				entry.timestamp - previous.timestamp < COALESCE_WINDOW_MS
			) {
				// keep the original `undo`, adopt the newest `redo`
				this.past[this.past.length - 1] = {
					...previous,
					redo: entry.redo,
					label: entry.label,
					timestamp: entry.timestamp
				};
				this.future.length = 0;
				return;
			}
		}

		this.past.push(entry);
		if (this.past.length > this.limit) this.past.shift();
		this.future.length = 0;
	}

	undo(): string | null {
		const command = this.past.pop();
		if (!command) return null;
		command.undo();
		this.future.push(command);
		return command.label;
	}

	redo(): string | null {
		const command = this.future.pop();
		if (!command) return null;
		command.redo();
		this.past.push({ ...command, timestamp: Date.now() });
		return command.label;
	}

	canUndo(): boolean {
		return this.past.length > 0;
	}

	canRedo(): boolean {
		return this.future.length > 0;
	}

	nextUndoLabel(): string | null {
		return this.past.length ? this.past[this.past.length - 1].label : null;
	}

	nextRedoLabel(): string | null {
		return this.future.length ? this.future[this.future.length - 1].label : null;
	}

	/** Break coalescing so the next command always starts a fresh entry. */
	seal(): void {
		const last = this.past[this.past.length - 1];
		if (last) last.timestamp = 0;
	}

	clear(): void {
		this.past.length = 0;
		this.future.length = 0;
	}

	depth(): { past: number; future: number } {
		return { past: this.past.length, future: this.future.length };
	}
}
