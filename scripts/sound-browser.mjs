import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = 4212,
	debugPort = 9372;
const mime = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml'
};
const server = createServer(async (req, res) => {
	try {
		let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		const at = pathname.indexOf('/_app/');
		if (at >= 0) pathname = pathname.slice(at);
		const base = path.join('build', pathname);
		const file = [base, `${base}.html`, path.join(base, 'index.html')].find(
			(file) => existsSync(file) && statSync(file).isFile()
		);
		if (!file) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' });
		res.end(await readFile(file));
	} catch (error) {
		res.writeHead(500);
		res.end(String(error));
	}
});
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const profile = await mkdtemp(path.join(tmpdir(), 'doodlesynth-sound-'));
const chrome = spawn(
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	[
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		'--mute-audio',
		'--autoplay-policy=no-user-gesture-required',
		'--window-size=1600,1000',
		`--user-data-dir=${profile}`,
		`--remote-debugging-port=${debugPort}`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let failures = 0,
	passes = 0;
const errors = [];
try {
	let url;
	for (let attempt = 0; attempt < 80 && !url; attempt++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
			url = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl;
		} catch {
			/* Chrome starting */
		}
		if (!url) await sleep(100);
	}
	if (!url) throw new Error('Chrome did not start');
	socket = new WebSocket(url);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve);
		socket.addEventListener('error', reject);
	});
	let id = 0;
	const pending = new Map();
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (message.id) {
			const request = pending.get(message.id);
			if (request) {
				pending.delete(message.id);
				if (message.error) request.reject(new Error(JSON.stringify(message.error)));
				else request.resolve(message.result);
			}
		} else if (message.method === 'Runtime.exceptionThrown')
			errors.push(message.params.exceptionDetails);
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const next = ++id;
			pending.set(next, { resolve, reject });
			socket.send(JSON.stringify({ id: next, method, params }));
		});
	const evaluate = async (expression) => {
		const result = await send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true
		});
		if (result.exceptionDetails)
			throw new Error(
				result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
			);
		return result.result.value;
	};
	const wait = async (expression) => {
		for (let i = 0; i < 100; i++) {
			if (await evaluate(expression)) return;
			await sleep(100);
		}
		throw new Error(`Timed out: ${expression}`);
	};
	const check = (name, result, detail) => {
		if (result) {
			passes++;
			console.log(`PASS ${name}`);
		} else {
			failures++;
			console.error(`FAIL ${name}`, detail ?? '');
		}
	};
	const click = async (expression) => {
		const rect = await evaluate(
			`(() => { const e = ${expression}; if (!e) throw new Error('Missing click target'); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
		);
		await send('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			...rect,
			button: 'left',
			clickCount: 1
		});
		await send('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			...rect,
			button: 'left',
			clickCount: 1
		});
		await sleep(100);
	};
	const buttons = (text) =>
		`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
	await send('Runtime.enable');
	await send('Page.enable');
	await send('Page.navigate', { url: `http://127.0.0.1:${port}/sounds` });
	await wait(`!!document.querySelector('.sound-name')`);
	check(
		'direct sounds route hydrates and initializes library',
		await evaluate(`window.__linesynth.session.project.soundProfiles.length===1`)
	);
	check(
		'three oscillator modules visible',
		await evaluate(`document.querySelectorAll('.oscillator').length===3`)
	);
	check(
		'default only oscillator 1 active',
		await evaluate(
			`window.__linesynth.session.project.soundProfiles[0].synth.oscillators.filter(o=>o.enabled).length===1`
		)
	);
	await click(`document.querySelector('[aria-label="Oscillator 2 power"]')`);
	check(
		'oscillator power edits real patch',
		await evaluate(
			`window.__linesynth.session.project.soundProfiles[0].synth.oscillators[1].enabled`
		)
	);
	await click(buttons('Effects'));
	check(
		'nine effects and PiPo mode available',
		await evaluate(
			`document.querySelectorAll('.effect').length===9 && !!Array.from(document.querySelectorAll('option')).find(o=>o.textContent.includes('PiPo'))`
		)
	);
	await click(`document.querySelector('[aria-label="delay power"]')`);
	await evaluate(
		`(() => { const e=Array.from(document.querySelectorAll('.effect select')).find(e=>Array.from(e.options).some(o=>o.value==='ping-pong')); e.value='ping-pong'; e.dispatchEvent(new Event('change',{bubbles:true})); })()`
	);
	check(
		'delay mode persists into synthesis settings',
		await evaluate(
			`window.__linesynth.session.project.soundProfiles[0].synth.delay.mode==='ping-pong'`
		)
	);
	const oldOrder = await evaluate(
		`window.__linesynth.session.project.soundProfiles[0].synth.effects.map(e=>e.kind)`
	);
	await click(`document.querySelector('[aria-label="Move delay up"]')`);
	check(
		'rack reorder changes saved signal order',
		(
			await evaluate(
				`window.__linesynth.session.project.soundProfiles[0].synth.effects.map(e=>e.kind)`
			)
		).indexOf('delay') ===
			oldOrder.indexOf('delay') - 1
	);
	await click(buttons('Matrix'));
	await click(buttons('+ Envelope'));
	await click(buttons('+ LFO'));
	check(
		'matrix assignments update profile',
		await evaluate(
			`window.__linesynth.session.project.soundProfiles[0].modEnvelopes.length===1 && window.__linesynth.session.project.soundProfiles[0].lfos.length===1`
		)
	);
	await click(buttons('Advanced'));
	check(
		'advanced phase/unison controls exist',
		await evaluate(`document.body.textContent.includes('Unison stereo spread')`)
	);
	await click(buttons('Wavetable'));
	await click(buttons('+ New table'));
	check(
		'wavetable asset is linked to chosen oscillator',
		await evaluate(
			`window.__linesynth.session.project.wavetables.some(t=>t.id===window.__linesynth.session.project.soundProfiles[0].synth.oscillators[0].wavetableId)`
		)
	);
	await click(buttons('Save as copy'));
	check(
		'copy creates independent sound profile',
		await evaluate(
			`window.__linesynth.session.project.soundProfiles.length===2 && window.__linesynth.session.project.soundProfiles[0].id!==window.__linesynth.session.project.soundProfiles[1].id`
		)
	);
	await click(buttons('Save project'));
	await wait(`window.__linesynth.session.saveState==='saved'`);
	await send('Page.reload');
	await sleep(100);
	await wait(
		`!!window.__linesynth && !!document.querySelector('.sound-name') && window.__linesynth.session.project.soundProfiles.length===2`
	);
	check(
		'sound library reload persistence',
		await evaluate(`window.__linesynth.session.project.soundProfiles.length===2`)
	);
	// Import through the actual file input interface.
	const presetPath = path.join(profile, 'test.vital');
	await writeFile(
		presetPath,
		JSON.stringify({
			synth_version: '1.0.8',
			preset_name: 'Browser Vital import',
			settings: { osc_1_on: 1, osc_1_transpose: 12, env_1_attack: 0.5 }
		})
	);
	const dom = await send('DOM.getDocument');
	const input = await send('DOM.querySelector', {
		nodeId: dom.root.nodeId,
		selector: 'input[type=file]'
	});
	await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [presetPath] });
	await wait(
		`window.__linesynth.session.project.soundProfiles.some(s=>s.name==='Browser Vital import')`
	);
	check(
		'Vital import shows compatibility notes',
		await evaluate(
			`document.querySelector('.import-notes')?.textContent.includes('Web Audio is not Vital')`
		)
	);
	await click(`document.querySelector('[aria-label="Audition C4"]')`);
	await wait(`window.__linesynth.engine.analysis().some(v=>Math.abs(v)>0.001)`);
	check(
		'keyboard auditions real processed patch',
		await evaluate(`window.__linesynth.engine.analysis().some(v=>Math.abs(v)>0.001)`)
	);
	await wait(`!document.querySelector('.keyboard .held')`);
	check(
		'audition highlight clears at note-off',
		await evaluate(`!document.querySelector('.keyboard .held')`)
	);
	await click(buttons('Stop'));
	await click(`document.querySelector('.starter-picker summary')`);
	const starterNames = [
		'Round sub',
		'Slow bloom',
		'Glass pluck',
		'Wide lead',
		'Drawbar organ',
		'Echo keys'
	];
	const starterIds = ['sub', 'pad', 'pluck', 'lead', 'organ', 'echo'];
	const initialSounds = await evaluate(`window.__linesynth.session.project.soundProfiles.length`);
	for (let i = 0; i < starterIds.length; i++) {
		await evaluate(
			`(() => { const e=document.querySelector('[aria-label="Starter sound"]'); e.value=${JSON.stringify(starterIds[i])}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`
		);
		await click(buttons('Add starter sound'));
		check(
			`starter ${starterNames[i]} creates a new selected patch`,
			await evaluate(
				`document.querySelector('.sound-name').value===${JSON.stringify(starterNames[i])} && window.__linesynth.session.project.soundProfiles.length===${initialSounds + i + 1}`
			)
		);
	}
	check(
		'starters do not create or replace tracks',
		await evaluate(`window.__linesynth.session.project.tracks.length===0`)
	);
	await click(`document.querySelector('[aria-label="Favorite sound"]')`);
	check(
		'favorite is stored in the project',
		await evaluate(
			`window.__linesynth.session.project.soundProfiles.find(s=>s.name==='Echo keys').favorite===true`
		)
	);
	await click(buttons('Undo'));
	check(
		'undo removes favorite',
		await evaluate(
			`!window.__linesynth.session.project.soundProfiles.find(s=>s.name==='Echo keys').favorite`
		)
	);
	await click(buttons('Redo'));
	await click(`document.querySelector('[aria-label="Show favorite sounds"]')`);
	check(
		'favorite filter shows only bookmarked sound',
		await evaluate(
			`document.querySelectorAll('.sound-card').length===1 && document.querySelector('.sound-card strong').textContent==='Echo keys'`
		)
	);
	await click(`document.querySelector('[aria-label="Show favorite sounds"]')`);
	await evaluate(
		`(() => { const e=document.querySelector('[aria-label="Sound category"]'); e.value='Ambient'; e.dispatchEvent(new Event('change',{bubbles:true})); })()`
	);
	await evaluate(
		`(() => { const e=document.querySelector('[aria-label="Filter sound category"]'); e.value='Ambient'; e.dispatchEvent(new Event('change',{bubbles:true})); })()`
	);
	check(
		'editable category filters library',
		await evaluate(
			`document.querySelectorAll('.sound-card').length===1 && document.querySelector('.sound-card strong').textContent==='Echo keys'`
		)
	);
	await evaluate(
		`(() => { const e=document.querySelector('[aria-label="Search sounds"]'); e.value='no such sound'; e.dispatchEvent(new Event('input',{bubbles:true})); })()`
	);
	check(
		'empty results offer a recovery action',
		await evaluate(`document.body.textContent.includes('No sounds match these filters.')`)
	);
	await click(buttons('Clear filters'));
	check(
		'clear filters restores complete library',
		await evaluate(
			`document.querySelectorAll('.sound-card').length===window.__linesynth.session.project.soundProfiles.length`
		)
	);
	await evaluate(
		`(() => { const e=document.querySelector('[aria-label="Search sounds"]'); e.value=' pad '; e.dispatchEvent(new Event('input',{bubbles:true})); })()`
	);
	check(
		'search matches categories and trims whitespace',
		await evaluate(
			`document.querySelectorAll('.sound-card').length===1 && document.querySelector('.sound-card strong').textContent==='Slow bloom'`
		)
	);
	await evaluate(
		`(() => { const e=document.querySelector('[aria-label="Search sounds"]'); e.value=''; e.dispatchEvent(new Event('input',{bubbles:true})); })()`
	);
	await wait(`window.__linesynth.session.saveState==='saved'`);
	await send('Page.reload');
	await sleep(100);
	await wait(
		`!!document.querySelector('.sound-name') && window.__linesynth.session.project.soundProfiles.some(s=>s.name==='Echo keys' && s.favorite && s.category==='Ambient')`
	);
	check(
		'starter patches, favorites and edited categories persist on reload',
		await evaluate(
			`window.__linesynth.session.project.soundProfiles.filter(s=>${JSON.stringify(starterNames)}.includes(s.name)).length===6`
		)
	);
	const screenshot = await send('Page.captureScreenshot', { format: 'png' });
	await writeFile(path.join(profile, 'sound-designer.png'), Buffer.from(screenshot.data, 'base64'));
	console.log(`Screenshot: ${profile}/sound-designer.png`);
	await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
	await wait(
		`!!window.__linesynth && window.__linesynth.session.initialized && !!document.querySelector('[aria-label="New track"]')`
	);
	if (await evaluate(`window.__linesynth.session.project.tracks.length===0`)) {
		await click(`document.querySelector('[aria-label="New track"]')`);
		await wait(`!!document.querySelector('[aria-label="Create track"]')`);
		await click(`document.querySelector('[aria-label="Create track"]')`);
	}
	await wait(`window.__linesynth.session.project.tracks.length>0`);
	check(
		'editor track chooses a sound profile',
		await evaluate(
			`!!window.__linesynth.session.project.tracks[0].soundProfileId && !!document.querySelector('[aria-label="Track sound profile"]')`
		)
	);
	// Choose an existing patch for a second track, then edit its shared name in the designer.
	await click(`document.querySelector('[aria-label="New track"]')`);
	await wait(`!!document.querySelector('[aria-label="Sound profile"]')`);
	await evaluate(
		`(() => { const e=document.querySelector('[aria-label="Sound profile"]'); e.value=window.__linesynth.session.project.tracks[0].soundProfileId; e.dispatchEvent(new Event('change',{bubbles:true})); })()`
	);
	await click(`document.querySelector('[aria-label="Create track"]')`);
	check(
		'new tracks can choose an existing shared sound',
		await evaluate(
			`window.__linesynth.session.project.tracks.length===2 && window.__linesynth.session.project.tracks[0].soundProfileId===window.__linesynth.session.project.tracks[1].soundProfileId`
		)
	);
	await wait(`window.__linesynth.session.saveState==='saved'`);
	const sharedId = await evaluate(`window.__linesynth.session.project.tracks[0].soundProfileId`);
	await send('Page.navigate', { url: `http://127.0.0.1:${port}/sounds?sound=${sharedId}` });
	await sleep(100);
	await wait(
		`!!window.__linesynth && !!document.querySelector('.sound-name') && !!window.__linesynth.session.project.soundProfiles.find(s=>s.id===${JSON.stringify(sharedId)}) && document.querySelector('.sound-name').value===window.__linesynth.session.project.soundProfiles.find(s=>s.id===${JSON.stringify(sharedId)}).name`
	);
	await evaluate(
		`(() => { const input=document.querySelector('.sound-name'); input.value='Shared browser patch'; input.dispatchEvent(new Event('change',{bubbles:true})); })()`
	);
	await click(`document.querySelector('[aria-label="Oscillator 2 power"]')`);
	check(
		'shared edits resolve to both linked tracks',
		await evaluate(
			`(() => { const tracks=window.__linesynth.session.project.tracks; return tracks[0].synth.oscillators[1].enabled && tracks[1].synth.oscillators[1].enabled && tracks[0].soundProfileId===tracks[1].soundProfileId && JSON.stringify(tracks[0].synth)===JSON.stringify(tracks[1].synth); })()`
		)
	);
	await click(buttons('Undo'));
	check(
		'undo restores shared edits on both tracks',
		await evaluate(
			`window.__linesynth.session.project.tracks.every(t=>!t.synth.oscillators[1].enabled)`
		)
	);
	await click(buttons('Redo'));
	check(
		'redo reapplies shared edits on both tracks',
		await evaluate(
			`window.__linesynth.session.project.tracks.every(t=>t.synth.oscillators[1].enabled)`
		)
	);
	const tracksBeforeStarter = await evaluate(
		`JSON.stringify(window.__linesynth.session.project.tracks)`
	);
	await click(`document.querySelector('.starter-picker summary')`);
	await click(buttons('Add starter sound'));
	check(
		'adding a starter preserves existing tracks, curves, mixer and sound links',
		(await evaluate(`JSON.stringify(window.__linesynth.session.project.tracks)`)) ===
			tracksBeforeStarter
	);
	await click(buttons('Undo'));
	const canceledAudition = await evaluate(`(async () => {
		const {engine,session}=window.__linesynth; const original=engine.context;
		let resume; const gate=new Promise(resolve=>{resume=resolve});
		engine.context=async function(){await gate;return original.call(this)};
		try {
			const pending=engine.previewSound(session.project.soundProfiles[0],220,1.5);
			engine.stopPreviewSound(); resume(); await pending;
			return engine.analysis().length===0;
		} finally {engine.context=original;engine.stopPreviewSound()}
	})()`);
	check('stop cancels an audition whose audio startup is still pending', canceledAudition);
	await send('Emulation.setDeviceMetricsOverride', {
		width: 768,
		height: 1000,
		deviceScaleFactor: 1,
		mobile: false
	});
	check(
		'tablet sound layout has no document horizontal overflow',
		await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`)
	);
	await send('Emulation.setEmulatedMedia', {
		features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
	});
	check(
		'reduced motion disables control transitions',
		await evaluate(
			`getComputedStyle(document.querySelector('.tabs button')).transitionDuration.split(',').every(v=>parseFloat(v)<=0.001)`
		)
	);
	await send('Emulation.clearDeviceMetricsOverride');
	// Audio measurement uses the same public engine interface as timeline playback.
	const measurement = await evaluate(`(async () => {
		const {engine,session}=window.__linesynth;
		const p=JSON.parse(JSON.stringify(session.project)); const track=p.tracks[0]; p.tracks=[track]; p.tempo=120; p.loop.enabled=false; p.master.synth.filter.enabled=false; p.master.synth.drive=0; p.master.synth.delay.mix=0; p.master.synth.reverb.mix=0;
		track.mixer={volumeDb:-18,pan:0,mute:false,solo:false}; track.lfos=[]; track.modEnvelopes=[]; track.automationLanes=[];
		track.curves=[{id:'audio-test',name:'Test',points:[{id:'a',time:0,frequency:440,interpolation:'linear'},{id:'b',time:2,frequency:440,interpolation:'linear'}],envelope:{attack:0,decay:0,sustain:1,release:0},gainDb:0,pan:0,muted:false}];
		track.synth.filter.enabled=false; track.synth.drive=0; track.synth.outputDb=0; track.synth.envelope=undefined; track.synth.noise={enabled:false,level:0,pan:0}; track.synth.effects=[]; track.synth.oscillators=[{enabled:true,wave:'sine',wavetablePosition:0,transpose:0,fineCents:0,level:1,pan:0,phase:0,phaseRandomization:0,unison:{voices:1,detuneCents:0,phaseSpread:0,stereoSpread:0},routing:'filter1'}];
		const render=async()=>{engine.setProject(p);return engine.renderOfflineBuffer(0,1.3)};
		const rms=(data,start=0.1,end=0.8)=>{let sum=0;const a=Math.floor(start*48000),b=Math.floor(end*48000);for(let i=a;i<b;i++)sum+=data[i]*data[i];return Math.sqrt(sum/(b-a));};
		let buffer=await render(); const single=rms(buffer.getChannelData(0));
		track.synth.oscillators[0].unison.voices=7; buffer=await render(); const seven=rms(buffer.getChannelData(0));
		track.synth.oscillators[0].unison.voices=16; buffer=await render(); const sixteen=rms(buffer.getChannelData(0));
		track.synth.oscillators[0].unison.voices=3; track.synth.oscillators[0].unison.detuneCents=20; track.synth.oscillators[0].unison.stereoSpread=1; buffer=await render(); const left=buffer.getChannelData(0),right=buffer.getChannelData(1); let stereoDifference=0; for(let i=4800;i<30000;i++)stereoDifference+=Math.abs(left[i]-right[i]);
		track.synth.oscillators[0].unison={voices:1,detuneCents:0,phaseSpread:0,stereoSpread:0};
		track.synth.oscillators[0].transpose=12; buffer=await render(); let crossings=0; const pitched=buffer.getChannelData(0); for(let i=4800;i<24000;i++)if(pitched[i-1]<=0&&pitched[i]>0)crossings++; const transposedHz=crossings/0.4;
		track.synth.oscillators[0].transpose=0;
		track.synth.filter={enabled:false,type:'lowpass',cutoff:80,resonance:1}; buffer=await render(); const bypass=rms(buffer.getChannelData(0));
		track.synth.filter.enabled=true; buffer=await render(); const filtered=rms(buffer.getChannelData(0)); track.synth.filter.enabled=false;
		track.synth.effects=[]; buffer=await render(); const baseline=buffer.getChannelData(0).slice();
		const effectResults=[];
		for(const kind of ['chorus','compressor','distortion','eq','filter','flanger','phaser','reverb']) {
			const defaults={chorus:{rate:0.6,depth:4,time:18},compressor:{threshold:-36,ratio:8,attack:5,release:150},distortion:{drive:0.5},eq:{low:0,mid:12,high:0,frequency:440},filter:{cutoff:120,resonance:1},flanger:{rate:0.25,depth:1,feedback:0.4},phaser:{rate:0.4,frequency:1000,depth:600},reverb:{decay:1.6,preDelay:10,damping:7000}};
			track.synth.effects=[{id:kind,kind,enabled:true,mix:kind==='eq'||kind==='filter'||kind==='compressor'?1:0.5,params:defaults[kind]}];
			buffer=await render(); const level=rms(buffer.getChannelData(0)); let difference=0; const data=buffer.getChannelData(0); for(let i=4800;i<38400;i++)difference+=Math.abs(data[i]-baseline[i]); effectResults.push({kind,level,difference,finite:data.every(Number.isFinite)});
		}
		track.curves[0].points[1].time=0.05;
		track.synth.delay={mix:1,time:0.15,rightTime:0.15,feedback:0.6,mode:'ping-pong',sync:false,lowCut:20,highCut:20000,width:1}; track.synth.effects=[{id:'delay',kind:'delay',enabled:true,mix:1,params:{}}];
		buffer=await render(); const energies=[1,2,3].map(n=>[rms(buffer.getChannelData(0),n*0.15+0.008,n*0.15+0.022),rms(buffer.getChannelData(1),n*0.15+0.008,n*0.15+0.022)]);
		track.synth.delay.sync=true; track.synth.delay.beats=0.5; buffer=await render(); const synced=[rms(buffer.getChannelData(0),0.26,0.27),rms(buffer.getChannelData(0),0.16,0.17)];
		track.synth.delay.sync=false; track.synth.delay.mode='mono'; buffer=await render(); const monoEcho=[rms(buffer.getChannelData(0),0.16,0.17),rms(buffer.getChannelData(1),0.16,0.17)];
		track.synth.delay.mode='stereo'; track.synth.delay.rightTime=0.25; buffer=await render(); const stereoEcho=[rms(buffer.getChannelData(0),0.16,0.17),rms(buffer.getChannelData(1),0.16,0.17),rms(buffer.getChannelData(1),0.26,0.27)];
		track.synth.delay.mode='ping-pong'; track.synth.delay.width=0; buffer=await render(); const narrowEcho=[rms(buffer.getChannelData(0),0.16,0.17),rms(buffer.getChannelData(1),0.16,0.17)];
		track.synth.delay.width=1; track.synth.delay.highCut=100; buffer=await render(); const darkEcho=rms(buffer.getChannelData(0),0.16,0.17);
		track.synth.effects=[]; track.curves=Array.from({length:100},(_,i)=>({...track.curves[0],id:'budget-'+i})); track.synth.oscillators[0].unison.voices=16; engine.setProject(p); await engine.play(0); const sourceCount=engine.debugState().sources; engine.stop();
		engine.setProject(session.project);
		return {single,seven,sixteen,stereoDifference,transposedHz,bypass,filtered,effectResults,energies,synced,monoEcho,stereoEcho,narrowEcho,darkEcho,sourceCount};
	})()`);
	console.log('Audio measurements', JSON.stringify(measurement, null, 2));
	check(
		'7-voice zero-detune stack matches one voice',
		Math.abs(measurement.seven / measurement.single - 1) < 0.015
	);
	check(
		'16-voice zero-detune stack matches one voice',
		Math.abs(measurement.sixteen / measurement.single - 1) < 0.015
	);
	check('detuned unison creates stereo difference', measurement.stereoDifference > 10);
	check('oscillator transpose affects actual pitch', Math.abs(measurement.transposedHz - 880) < 5);
	check(
		'PiPo first echo left, second right, third left',
		measurement.energies[0][0] > measurement.energies[0][1] * 10 &&
			measurement.energies[1][1] > measurement.energies[1][0] * 10 &&
			measurement.energies[2][0] > measurement.energies[2][1] * 10
	);
	check(
		'delay feedback decays successive echoes',
		measurement.energies[0][0] > measurement.energies[1][1] &&
			measurement.energies[1][1] > measurement.energies[2][0]
	);
	check(
		'delay beat sync changes actual echo time',
		measurement.synced[0] > measurement.synced[1] * 10
	);
	check(
		'source node budget is bounded',
		measurement.sourceCount <= 256 && measurement.sourceCount > 0
	);
	check(
		'disabled low-cutoff filter is a real bypass',
		Math.abs(measurement.bypass / measurement.single - 1) < 0.015 &&
			measurement.filtered < measurement.bypass * 0.1
	);
	for (const result of measurement.effectResults)
		check(
			`${result.kind} renders finite non-silent audio`,
			result.finite && result.level > 0.00001 && result.difference > 1
		);
	check(
		'mono delay repeats equally in both channels',
		measurement.monoEcho[0] > 0.01 &&
			Math.abs(measurement.monoEcho[0] - measurement.monoEcho[1]) < 0.0001
	);
	check(
		'stereo delay uses independent right timing',
		measurement.stereoEcho[0] > measurement.stereoEcho[1] * 10 && measurement.stereoEcho[2] > 0.01
	);
	check(
		'zero-width PiPo becomes mono',
		measurement.narrowEcho[0] > 0.01 &&
			Math.abs(measurement.narrowEcho[0] - measurement.narrowEcho[1]) < 0.0001
	);
	check(
		'feedback high-cut shapes the audible echo',
		measurement.darkEcho < measurement.energies[0][0] * 0.2
	);
	const starterAudio = await evaluate(`(async () => {
		const {engine,session}=window.__linesynth; const results=[];
		try {
			for(const name of ${JSON.stringify(['Round sub', 'Slow bloom', 'Glass pluck', 'Wide lead', 'Drawbar organ', 'Echo keys'])}) {
				const p=JSON.parse(JSON.stringify(session.project)); const sound=p.soundProfiles.find(s=>s.name===name); const t=p.tracks[0];
				t.synth=sound.synth; t.lfos=sound.lfos; t.modEnvelopes=sound.modEnvelopes; t.automationLanes=[]; t.mixer={volumeDb:0,pan:0,mute:false,solo:false};
				t.curves=[{id:'starter-test',name:'Test',points:[{id:'a',time:0,frequency:220,interpolation:'linear'},{id:'b',time:3,frequency:220,interpolation:'linear'}],envelope:sound.synth.envelope,gainDb:0,pan:0,muted:false}];
				p.tracks=[t]; p.tempo=120; p.loop.enabled=false; p.master.synth.filter.enabled=false; p.master.synth.drive=0; p.master.synth.delay.mix=0; p.master.synth.reverb.mix=0; p.master.automationLanes=[]; p.master.modEnvelopes=[]; p.master.mixer={volumeDb:0,pan:0,mute:false,solo:false};
				engine.setProject(p); const buffer=await engine.renderOfflineBuffer(0,3); let sum=0,peak=0,finite=true;
				for(let ch=0;ch<buffer.numberOfChannels;ch++)for(const v of buffer.getChannelData(ch)){sum+=v*v;peak=Math.max(peak,Math.abs(v));finite=finite&&Number.isFinite(v);}
				results.push({name,rms:Math.sqrt(sum/(buffer.length*buffer.numberOfChannels)),peak,finite});
			}
		} finally { engine.setProject(session.project); }
		return results;
	})()`);
	console.log('Starter audio measurements', JSON.stringify(starterAudio, null, 2));
	for (const result of starterAudio)
		check(
			`${result.name} renders finite audible non-clipping audio`,
			result.finite && result.rms > 0.001 && result.peak < 1,
			result
		);
	check('no uncaught browser exceptions', errors.length === 0, errors);
} catch (error) {
	failures++;
	console.error(error);
} finally {
	socket?.close();
	chrome.kill();
	await new Promise((resolve) => server.close(resolve));
}
console.log(`${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
