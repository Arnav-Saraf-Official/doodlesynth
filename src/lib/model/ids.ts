let counter = 0;

/** Collision-resistant, sortable-enough ids for model entities. */
export function uid(prefix = 'id'): string {
	counter += 1;
	return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
		.toString(36)
		.slice(2, 6)}`;
}
