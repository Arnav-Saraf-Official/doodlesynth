<script lang="ts">
	import { onMount } from 'svelte';
	import { engine } from '#lib/audio/engine';
	let canvas: HTMLCanvasElement | undefined = $state();
	let spectrum = $state(false);
	onMount(() => {
		const timer = setInterval(() => {
			if (!canvas || document.hidden) return;
			const context = canvas.getContext('2d');
			if (!context) return;
			const data = engine.analysis(spectrum),
				width = 180,
				height = 44;
			context.clearRect(0, 0, width, height);
			context.strokeStyle = getComputedStyle(canvas).getPropertyValue('--color-accent').trim();
			context.lineWidth = 1.3;
			context.beginPath();
			for (let x = 0; x < width; x++) {
				const index = spectrum
					? Math.min(data.length - 1, Math.floor(Math.pow(x / width, 2) * data.length))
					: Math.floor((x / width) * Math.min(data.length, 512));
				const value = data[index] ?? (spectrum ? -100 : 0);
				const y = spectrum
					? height - Math.max(0, Math.min(1, (value + 100) / 100)) * height
					: height / 2 - value * 20;
				if (x === 0) context.moveTo(x, y);
				else context.lineTo(x, y);
			}
			context.stroke();
		}, 50);
		return () => clearInterval(timer);
	});
</script>

<button
	class="analyzer"
	aria-label={`Output ${spectrum ? 'spectrum' : 'oscilloscope'}; click to switch`}
	onclick={() => (spectrum = !spectrum)}
>
	<canvas
		{@attach (element) => {
			canvas = element;
			return () => {
				canvas = undefined;
			};
		}}
		width="180"
		height="44"
		aria-hidden="true"
	></canvas><span>{spectrum ? 'SPECTRUM' : 'OSCILLOSCOPE'}</span>
</button>

<style>
	.analyzer {
		position: relative;
		padding: 0;
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-2);
		background: var(--color-ed-0);
		cursor: pointer;
	}
	canvas {
		display: block;
		width: 180px;
		height: 44px;
	}
	span {
		position: absolute;
		right: 5px;
		bottom: 1px;
		font: 8px var(--font-mono);
		color: var(--color-fg-1);
	}
</style>
