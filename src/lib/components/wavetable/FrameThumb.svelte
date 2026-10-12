<script lang="ts">
	/**
	 * Miniature waveform view used in the frame strip and the library list.
	 * It reads the frame's cached samples directly — no re-render per row —
	 * so a library of twenty tables still draws in one frame.
	 */
	interface Props {
		samples: Float32Array | readonly number[];
		width?: number;
		height?: number;
		accent?: string;
	}

	let { samples, width = 36, height = 18, accent = 'var(--color-accent)' }: Props = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);

	function resolveColor(name: string, fallback: string): string {
		if (!canvas) return fallback;
		return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
	}

	$effect(() => {
		const element = canvas;
		if (!element) return;
		const dpr = window.devicePixelRatio || 1;
		element.width = Math.max(1, Math.round(width * dpr));
		element.height = Math.max(1, Math.round(height * dpr));
		const context = element.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, width, height);

		const data = samples;
		if (!data || data.length === 0) return;

		let peak = 0;
		for (let index = 0; index < data.length; index++) peak = Math.max(peak, Math.abs(data[index]));
		const scale = peak > 0 ? (height / 2 - 1) / peak : 0;
		const accentColor = accent.startsWith('var(')
			? resolveColor(accent.slice(4, accent.length - 1), '#4da3ff')
			: accent;

		const columns = Math.max(2, Math.round(width));
		const perColumn = Math.max(1, Math.floor(data.length / columns));
		context.fillStyle = accentColor;
		context.globalAlpha = 0.85;
		for (let column = 0; column < columns; column++) {
			const start = column * perColumn;
			let min = 0;
			let max = 0;
			for (let index = start; index < Math.min(start + perColumn, data.length); index++) {
				const value = data[index];
				if (value < min) min = value;
				if (value > max) max = value;
			}
			const y = height / 2 - max * scale;
			const barHeight = Math.max(1, (max - min) * scale);
			context.fillRect(column, y, 1, barHeight);
		}
		context.globalAlpha = 1;
	});
</script>

<canvas bind:this={canvas} style="width:{width}px; height:{height}px" aria-hidden="true"></canvas>

<style>
	canvas {
		display: block;
	}
</style>
