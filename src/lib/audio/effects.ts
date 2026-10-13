import type { DelaySettings, SoundEffect } from '#lib/model/types';

export const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export interface AudioModule {
	input: GainNode;
	output: GainNode;
	wet: GainNode;
	dry: GainNode;
	nodes: AudioNode[];
	sources: OscillatorNode[];
	dispose: () => void;
}

function moduleBase(ctx: BaseAudioContext, mix: number): AudioModule {
	const input = ctx.createGain(),
		output = ctx.createGain(),
		wet = ctx.createGain(),
		dry = ctx.createGain();
	wet.gain.value = clamp(mix, 0, 1);
	dry.gain.value = 1 - clamp(mix, 0, 1);
	input.connect(dry).connect(output);
	wet.connect(output);
	const nodes: AudioNode[] = [input, output, wet, dry];
	const sources: OscillatorNode[] = [];
	return {
		input,
		output,
		wet,
		dry,
		nodes,
		sources,
		dispose: () => {
			for (const source of sources) source.stop();
			for (const node of nodes) node.disconnect();
		}
	};
}

/** Fractional-beat sync uses project tempo; right timing is independent in stereo mode. */
export function delayTimes(settings: DelaySettings, tempo: number): [number, number] {
	const beat = 60 / clamp(tempo, 20, 400);
	const left = settings.sync ? (settings.beats ?? 0.5) * beat : settings.time;
	const right = settings.sync
		? (settings.rightBeats ?? settings.beats ?? 0.5) * beat
		: (settings.rightTime ?? settings.time);
	return [clamp(left, 0.005, 8), clamp(right, 0.005, 8)];
}

export interface DelayModule extends AudioModule {
	update: (settings: DelaySettings, tempo: number, mix?: number) => void;
}

export function createDelay(
	ctx: BaseAudioContext,
	settings: DelaySettings,
	tempo: number
): DelayModule {
	const mod = moduleBase(ctx, settings.mix);
	const left = ctx.createDelay(8),
		right = ctx.createDelay(8);
	const fbLeft = ctx.createGain(),
		fbRight = ctx.createGain();
	const highLeft = ctx.createBiquadFilter(),
		highRight = ctx.createBiquadFilter();
	const lowLeft = ctx.createBiquadFilter(),
		lowRight = ctx.createBiquadFilter();
	const merger = ctx.createChannelMerger(2);
	const splitter = ctx.createChannelSplitter(2);
	const mono = ctx.createGain();
	mono.channelCount = 1;
	mono.channelCountMode = 'explicit';
	const width = ctx.createStereoPanner();
	mod.nodes.push(
		left,
		right,
		fbLeft,
		fbRight,
		highLeft,
		highRight,
		lowLeft,
		lowRight,
		merger,
		splitter,
		mono,
		width
	);
	highLeft.type = highRight.type = 'highpass';
	lowLeft.type = lowRight.type = 'lowpass';
	left.connect(highLeft).connect(lowLeft);
	right.connect(highRight).connect(lowRight);
	lowLeft.connect(merger, 0, 0);
	lowRight.connect(merger, 0, 1);
	merger.connect(width).connect(mod.wet);
	let mode = '';
	const update = (s: DelaySettings, bpm: number, mix = s.mix) => {
		const desired = s.mode ?? 'stereo';
		if (mode !== desired) {
			mod.input.disconnect();
			mod.input.connect(mod.dry);
			mono.disconnect();
			splitter.disconnect();
			fbLeft.disconnect();
			fbRight.disconnect();
			lowLeft.disconnect();
			lowRight.disconnect();
			lowLeft.connect(merger, 0, 0);
			lowRight.connect(merger, 0, 1);
			lowLeft.connect(fbLeft);
			lowRight.connect(fbRight);
			if (desired === 'ping-pong') {
				mod.input.connect(mono).connect(left);
				fbLeft.connect(right);
				fbRight.connect(left);
			} else if (desired === 'mono') {
				mod.input.connect(mono);
				mono.connect(left);
				mono.connect(right);
				fbLeft.connect(left);
				fbRight.connect(right);
			} else {
				mod.input.connect(splitter);
				splitter.connect(left, 0);
				splitter.connect(right, 1);
				fbLeft.connect(left);
				fbRight.connect(right);
			}
			mode = desired;
		}
		const [l, r] = delayTimes(s, bpm);
		left.delayTime.setTargetAtTime(l, ctx.currentTime, 0.01);
		right.delayTime.setTargetAtTime(desired === 'stereo' ? r : l, ctx.currentTime, 0.01);
		fbLeft.gain.value = fbRight.gain.value = clamp(s.feedback, 0, 0.95);
		const lowCut = clamp(s.lowCut ?? 20, 20, 18000);
		const highCut = clamp(s.highCut ?? 12000, lowCut + 1, Math.min(20000, ctx.sampleRate * 0.49));
		highLeft.frequency.value = highRight.frequency.value = lowCut;
		lowLeft.frequency.value = lowRight.frequency.value = highCut;
		// StereoPanner is not a width control: apply width with a mid/side matrix below instead.
		width.pan.value = 0;
		mod.wet.gain.value = clamp(mix, 0, 1);
		mod.dry.gain.value = 1 - clamp(mix, 0, 1);
	};
	// Output width: crossfeed L/R with (1±width)/2, preserving the mid signal.
	merger.disconnect();
	const outSplit = ctx.createChannelSplitter(2),
		outMerge = ctx.createChannelMerger(2);
	const ll = ctx.createGain(),
		lr = ctx.createGain(),
		rl = ctx.createGain(),
		rr = ctx.createGain();
	mod.nodes.push(outSplit, outMerge, ll, lr, rl, rr);
	merger.connect(outSplit);
	outSplit.connect(ll, 0);
	outSplit.connect(lr, 0);
	outSplit.connect(rl, 1);
	outSplit.connect(rr, 1);
	ll.connect(outMerge, 0, 0);
	rl.connect(outMerge, 0, 0);
	lr.connect(outMerge, 0, 1);
	rr.connect(outMerge, 0, 1);
	outMerge.connect(width);
	const updateWidth = (s: DelaySettings, bpm: number, mix?: number) => {
		update(s, bpm, mix);
		const w = clamp(s.width ?? 1, 0, 1);
		ll.gain.value = rr.gain.value = (1 + w) / 2;
		lr.gain.value = rl.gain.value = (1 - w) / 2;
	};
	updateWidth(settings, tempo);
	return { ...mod, update: updateWidth };
}

function saturation(amount: number): Float32Array<ArrayBuffer> {
	const out = new Float32Array(2048);
	const drive = 1 + clamp(amount, 0, 1) * 20;
	for (let i = 0; i < out.length; i++) {
		const x = (i / (out.length - 1)) * 2 - 1;
		out[i] = Math.tanh(x * drive) / Math.tanh(drive);
	}
	return out;
}

function createEffect(ctx: BaseAudioContext, effect: SoundEffect): AudioModule {
	const mod = moduleBase(ctx, effect.mix),
		p = effect.params;
	const add = <T extends AudioNode>(node: T): T => {
		mod.nodes.push(node);
		return node;
	};
	if (effect.kind === 'distortion') {
		const node = add(ctx.createWaveShaper());
		node.curve = saturation(p.drive);
		node.oversample = '2x';
		mod.input.connect(node).connect(mod.wet);
	} else if (effect.kind === 'compressor') {
		const node = add(ctx.createDynamicsCompressor());
		node.threshold.value = clamp(p.threshold, -60, 0);
		node.ratio.value = clamp(p.ratio, 1, 20);
		node.attack.value = clamp(p.attack / 1000, 0.001, 0.1);
		node.release.value = clamp(p.release / 1000, 0.01, 1);
		mod.input.connect(node).connect(mod.wet);
	} else if (effect.kind === 'eq') {
		let previous: AudioNode = mod.input;
		for (const [type, frequency, gain] of [
			['lowshelf', 200, p.low],
			['peaking', p.frequency, p.mid],
			['highshelf', 5000, p.high]
		] as [BiquadFilterType, number, number][]) {
			const node = add(ctx.createBiquadFilter());
			node.type = type;
			node.frequency.value = clamp(frequency, 20, 20000);
			node.gain.value = clamp(gain, -18, 18);
			node.Q.value = 1;
			previous.connect(node);
			previous = node;
		}
		previous.connect(mod.wet);
	} else if (effect.kind === 'filter') {
		const node = add(ctx.createBiquadFilter());
		node.frequency.value = clamp(p.cutoff, 20, 20000);
		node.Q.value = clamp(p.resonance, 0, 20);
		mod.input.connect(node).connect(mod.wet);
	} else if (effect.kind === 'reverb') {
		const convolver = add(ctx.createConvolver()),
			pre = add(ctx.createDelay(0.3)),
			filter = add(ctx.createBiquadFilter());
		const seconds = clamp(p.decay, 0.1, 8);
		const buffer = ctx.createBuffer(2, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
		let seed = 123456789;
		for (let ch = 0; ch < 2; ch++) {
			const data = buffer.getChannelData(ch);
			for (let i = 0; i < data.length; i++) {
				seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				data[i] = (((seed >>> 0) / 0xffffffff) * 2 - 1) * Math.pow(1 - i / data.length, 3);
			}
		}
		convolver.buffer = buffer;
		pre.delayTime.value = clamp(p.preDelay / 1000, 0, 0.25);
		filter.frequency.value = clamp(p.damping, 500, 20000);
		mod.input.connect(pre).connect(convolver).connect(filter).connect(mod.wet);
	} else if (effect.kind === 'phaser') {
		const lfo = add(ctx.createOscillator());
		lfo.frequency.value = clamp(p.rate, 0.05, 10);
		let previous: AudioNode = mod.input;
		for (let i = 0; i < 4; i++) {
			const filter = add(ctx.createBiquadFilter());
			filter.type = 'allpass';
			filter.frequency.value = clamp(p.frequency * (1 + i * 0.25), 100, 15000);
			const depth = add(ctx.createGain());
			depth.gain.value = clamp(p.depth, 0, Math.max(0, filter.frequency.value - 20));
			lfo.connect(depth).connect(filter.frequency);
			previous.connect(filter);
			previous = filter;
		}
		previous.connect(mod.wet);
		lfo.start(ctx.currentTime);
		mod.sources.push(lfo);
	} else if (effect.kind === 'chorus' || effect.kind === 'flanger') {
		const split = add(ctx.createChannelSplitter(2)),
			merge = add(ctx.createChannelMerger(2));
		mod.input.connect(split);
		for (let channel = 0; channel < 2; channel++) {
			const delay = add(ctx.createDelay(0.1)),
				lfo = add(ctx.createOscillator()),
				depth = add(ctx.createGain()),
				feedback = add(ctx.createGain());
			const base = effect.kind === 'chorus' ? clamp(p.time / 1000, 0.005, 0.04) : 0.006;
			delay.delayTime.value = base;
			depth.gain.value = clamp(p.depth / 1000, 0, base * 0.9);
			lfo.frequency.value = clamp(p.rate * (channel === 0 ? 1 : 1.013), 0.05, 10);
			split.connect(delay, channel);
			delay.connect(merge, 0, channel);
			if (effect.kind === 'flanger') {
				feedback.gain.value = clamp(p.feedback, 0, 0.9);
				delay.connect(feedback).connect(delay);
			}
			lfo.connect(depth).connect(delay.delayTime);
			lfo.start(ctx.currentTime);
			mod.sources.push(lfo);
		}
		merge.connect(mod.wet);
	}
	return mod;
}

export interface EffectRack {
	input: GainNode;
	output: GainNode;
	delay: DelayModule | null;
	reverb: AudioModule | null;
	modules: AudioModule[];
	dispose: () => void;
}
export function createEffectRack(
	ctx: BaseAudioContext,
	effects: SoundEffect[],
	delaySettings: DelaySettings,
	tempo: number
): EffectRack {
	const input = ctx.createGain(),
		output = ctx.createGain();
	let previous: AudioNode = input;
	const modules: AudioModule[] = [];
	let delay: DelayModule | null = null,
		reverb: AudioModule | null = null;
	for (const effect of effects) {
		if (!effect.enabled) continue;
		const mod =
			effect.kind === 'delay'
				? createDelay(ctx, { ...delaySettings, mix: effect.mix }, tempo)
				: createEffect(ctx, effect);
		if (effect.kind === 'delay') delay = mod as DelayModule;
		if (effect.kind === 'reverb') reverb = mod;
		modules.push(mod);
		previous.connect(mod.input);
		previous = mod.output;
	}
	previous.connect(output);
	return {
		input,
		output,
		delay,
		reverb,
		modules,
		dispose: () => {
			input.disconnect();
			output.disconnect();
			for (const mod of modules) mod.dispose();
		}
	};
}
