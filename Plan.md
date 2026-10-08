# Line Synth — Svelte Static Web Instrument / DAW Specification

## 0. Product definition

Build a desktop-first, static Svelte/SvelteKit application that behaves like a small experimental DAW, but replaces the conventional MIDI-note rectangle workflow with **continuous pitch curves**.

The core primitive is not a MIDI note. It is a **voice path**:

- X axis = musical time.
- Y axis = continuous oscillator frequency in Hz.
- A path is drawn as a curve through editable control points.
- The curve can move through any frequency in the allowed range rather than being constrained to semitones.
- Each path has a start/end time and an amplitude/gate envelope.
- Multiple paths can overlap and form chords/polyphonic passages.
- Each track chooses an oscillator source: built-in waveform or a user-created wavetable.
- Track-level parameters and a global/master track can automate volume, filter, wavetable position, pitch offsets, effects, and other synthesis controls.

The application should feel like a **precision vector editor for sound** rather than a conventional piano roll with unusual MIDI behavior.

The first release does **not** need audio export. It should, however, be architected so that the project model can later be rendered through Web Audio and exported without redesigning the editor.

---

# 1. Product goals

## Primary goals

1. Make arbitrary pitch trajectories easy to draw.
2. Make editing those trajectories substantially faster than entering MIDI notes and pitch-bend automation.
3. Keep the UI understandable despite continuous frequency and effectively unbounded horizontal time.
4. Make sound design part of the same editing workflow rather than a separate synthesizer window.
5. Make custom wavetables first-class project assets.
6. Support dense automation without turning the UI into a maze of controls.
7. Work entirely client-side in a static deployment.
8. Preserve projects locally between sessions.
9. Keep rendering responsive for very large projects.
10. Leave a clean path toward live playback, offline rendering, WAV/AIFF export, and eventually project-file import/export.

## Secondary goals

- Keyboard-heavy operation for power users.
- Excellent zooming and navigation.
- Accurate snapping without forcing everything onto a grid.
- Strong visual feedback for selection, playback, automation, and edit operations.
- Data model independent of Svelte components so the audio engine, export system, and future file format can reuse it.

## Explicit non-goals for v1

- Full MIDI compatibility.
- DAW-level plugin hosting.
- Cloud collaboration.
- Server-side accounts.
- Multi-user editing.
- Full audio recording.
- Audio export as a requirement for the initial release.

---

# 2. Technology architecture

## Recommended stack

- Svelte 5 / SvelteKit.
- TypeScript.
- Vite through SvelteKit.
- Static adapter for deployment.
- HTML/CSS for application chrome and controls.
- Canvas 2D for high-density timeline rendering.
- Web Audio API for eventual live playback.
- AudioWorklet for custom real-time synthesis when playback is added.
- OfflineAudioContext for eventual offline rendering/export.
- IndexedDB for large project persistence.
- localStorage for small preferences and, if desired, a lightweight copy of custom wavetable metadata.

Current Svelte documentation supports the modern runes model, including `$state`, and SvelteKit is explicitly designed to support prerendering/static output. The official Svelte package listing currently lists `@sveltejs/adapter-static` as the adapter for static sites. [Svelte docs](https://svelte.dev/docs) [SvelteKit](https://svelte.dev/docs/kit/introduction)

The audio architecture should target Web Audio rather than inventing a parallel browser-only audio system. `AudioWorklet` is intended for custom processing on a separate audio thread, while `OfflineAudioContext` can render an audio graph into an `AudioBuffer` for later export. [MDN AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet) [MDN OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext)

## Important architectural rule

Do **not** store the editor's authoritative state in individual Svelte components.

Use a central project model:

```text
ProjectState
├── project metadata
├── tempo / time signature / playback settings
├── global editor settings
├── tracks[]
│   ├── path/voice data[]
│   ├── instrument settings
│   ├── track automation lanes[]
│   └── track mixer state
├── master automation lanes[]
├── wavetable definitions[]
├── markers[]
└── UI-independent preferences
```

Svelte state should be a reactive view/controller layer on top of that model.

This makes undo/redo, serialization, export, testing, audio playback, and eventual file import much easier.

---

# 3. Project coordinate system

The project should never use pixels as its source of truth.

Use continuous model coordinates:

```ts
interface TimePosition {
	beats: number;
}

interface PitchPosition {
	hz: number;
}

interface CurvePoint {
	id: string;
	time: number; // beats
	frequency: number; // Hz
	tangentIn?: number;
	tangentOut?: number;
}
```

Pixels are generated by the viewport transform.

## Time

Internally use beats or ticks rather than seconds.

For example:

```text
1 beat = quarter note at the current tempo
480 or 960 ticks/beat for optional high-resolution editing
```

A transport clock converts beats to seconds:

```text
seconds = beats * 60 / BPM
```

Do not permanently bake BPM into note positions.

This means changing tempo changes playback duration while preserving the musical structure.

## Frequency

Represent pitch directly in Hz.

Default range:

```text
20 Hz → 10,000 Hz
```

But do not architect the data model around exactly 10 kHz. The editor should allow the upper/lower limits to be changed later.

The editor exposes **two separate pitch-map systems**:

1. **Piano Map** — a musical/note-oriented renderer with octave bands, note guides, scale degrees, roots, and tuning targets.
2. **Frequency Map** — a raw continuous-frequency renderer whose axis is explicitly measured in Hz.

These are not two skins for the same grid. Each map has its own renderer, guides, hit-testing rules, and navigation behavior. The project model remains continuous frequency, so switching maps never changes curve data.

The Frequency Map supports two projections:

```text
logarithmic  → default
linear Hz    → optional analytical mode
```

The logarithmic projection is the practical default across a wide 20 Hz–10 kHz workspace because equal ratios occupy similar vertical distances. The linear projection is useful when exact absolute frequency spacing matters.

The Frequency Map may also enable a **Piano/Scale Overlay**. The overlay draws musical reference lines on top of the raw-Hz axis but never changes the underlying coordinate system or snapping semantics.

---

# 4. Main application layout

The application should have five major regions.

```text
┌───────────────────────────────────────────────────────────────────────┐
│ TOP BAR: logo | project | undo | redo | tempo | time sig | transport │
├───────────────┬───────────────────────────────────────────────────────┤
│               │                                                       │
│   TRACK /     │              MAIN CURVE EDITOR                       │
│   PARAMETER   │                                                       │
│   INSPECTOR   │                                                       │
│               │                                                       │
│               │                                                       │
├───────────────┴───────────────────────────────────────────────────────┤
│ TOOLBAR / CONTEXT BAR                                                 │
├───────────────────────────────────────────────────────────────────────┤
│ BOTTOM TABS: Master | Track 1 | Track 2 | Track 3 | +                │
└───────────────────────────────────────────────────────────────────────┘
```

The key visual principle is that the **central editor gets most of the screen**.

Avoid the common mistake of covering 30–40% of the viewport with settings panels.

---

# 5. Top transport bar

Keep this compact and always visible.

## Controls

- Project name.
- New project.
- Open project later.
- Save/local persistence status.
- Undo.
- Redo.
- Play/pause.
- Stop.
- Record later.
- Loop toggle.
- BPM.
- Time signature.
- Current playhead position.
- Snap menu.
- Zoom controls.
- CPU/audio status once audio exists.

Example layout:

```text
[Line Synth]  My Project      ↶ ↷     ◀ ▶ ■   LOOP
                                 128 BPM  4/4
                       003:02.250   SNAP: 1/16
```

The transport should not become a huge toolbar. Secondary controls can live in a command palette or preferences menu.

---

# 6. Bottom track tabs

The bottom tab system is one of the defining interaction choices.

Tabs should look like DAW tracks, but remain visually lighter.

```text
┌────────┬──────────┬──────────┬──────────┬─────┐
│ MASTER │ Lead     │ Bass     │ Texture  │  +  │
└────────┴──────────┴──────────┴──────────┴─────┘
```

Each track tab contains:

- Track color/icon.
- Track name.
- Mute indicator.
- Solo indicator.
- Small activity meter later.
- Waveform badge.
- Close button on hover.

## Track creation

Click `+`:

```text
New Track
──────────────
Name: [Lead       ]
Wave: [Sine       ▼]
Color: [auto]
Create
```

Do not immediately open a giant modal.

## Track switching

Switching track tabs changes the central editor to that track.

The timeline viewport should normally remain at the same horizontal location and zoom so users can compare tracks.

Vertical pitch zoom can be shared globally or remembered per track, but shared behavior should be the default.

---

# 7. The master track

The Master tab is special.

It does not draw pitch curves.

Instead, it exposes time-based automation across the complete project **plus a dedicated Musical State lane for scale/root/tuning changes**.

The master timeline is therefore conceptually divided into:

```text
MUSICAL STATE
  Root / Scale / Tuning keyframes

AUTOMATION
  Volume
  Filter Cutoff
  Resonance
  Wavetable Position
  ...
```

Musical State is not ordinary numeric automation. A keyframe selects a discrete musical configuration that becomes active until the next keyframe. Continuous properties such as reference frequency may optionally interpolate.

The primary view becomes:

```text
      Volume       ─────────╲____╱────────
      Filter Cut   ───────╱──────────────
      Resonance    ──────────────────────
      Wavetable    ───╱╲──────╱╲────────
      Reverb Mix   ──────────────────────
```

Each lane is a value curve against time.

## Master automation candidates

- Master volume.
- Master gain.
- Low-pass cutoff.
- High-pass cutoff.
- Resonance.
- Drive/saturation.
- Stereo width.
- Pan.
- Reverb send/mix.
- Delay send/mix.
- Master wavetable macro if implemented.
- Custom user-defined macro parameters later.

Not every feature needs to exist on day one. The automation engine should be generic enough that adding a parameter is data configuration rather than a rewrite.

---

# 8. Main track editor

This is the most important screen.

## Visual composition

```text
             10 kHz ───────────────────────────────
                    ╲                              │
                     ╲                             │
  4 kHz ───────────────╲───────╱─────────────────│
                         ╲___╱                    │
  1 kHz ─────────────────────────────────────────│
                     ╱                            │
   220 Hz ──────────╱────────────────────────────│
          piano/grid            time →           │
```

Time runs left-to-right.

Frequency runs bottom-to-top.

The playhead is a strong vertical line.

Grid lines should be subtle.

Curve paths should be the most visually prominent objects after selection/playback feedback.

---

# 9. Curve primitive

A voice is a piecewise curve.

Each curve contains editable control points.

Example:

```text
start ●────────╮
               ╰────●
                    ╲
                     ╲────●
                          ╱
                        ● end
```

## Point types

Support three point behaviors:

1. Corner.
2. Smooth.
3. Handle-controlled Bezier.

Default should be smooth/Bezier interpolation because it makes pitch glides easy.

## Why not just use sampled points?

Because users need to edit trajectories without creating thousands of control points.

Store a compact curve representation and sample it only during rendering/playback.

## Suggested representation

```ts
interface CurvePoint {
	id: string;
	time: number;
	frequency: number;
	interpolation: 'linear' | 'smooth' | 'bezier';
	inHandle?: { dt: number; df: number };
	outHandle?: { dt: number; df: number };
}
```

This supports expressive pitch movement while keeping the model small.

---

# 10. Drawing interaction

The editor should have a highly optimized drawing workflow.

## Pen/draw mode

Left-drag in empty space:

1. Start a new curve.
2. Continue dragging to create the curve.
3. Release to finish.
4. Automatically simplify/smooth the path.
5. Apply snapping according to the selected mode.

However, do **not** generate one control point for every mouse event.

Sample the pointer at high frequency, then simplify using a line/curve simplification algorithm.

## Add points

Click an existing curve to select it.

Double-click the curve to add a control point.

Drag the point to change its pitch/time.

Alt/Option-drag a tangent handle to control curvature.

## Delete points

Select point + Delete.

If removing a point would make a curve invalid, preserve the endpoints.

## Split curve

Place cursor over a path and press `S` or use a context menu:

```text
Split Curve Here
```

This is useful for changing synthesis behavior or envelopes between sections.

## Join curves

Select two adjacent curve endpoints and choose `Join`.

---

# 11. Note-like usability without restricting pitch

The interface should not abandon normal musical concepts just because pitch is continuous.

Provide a pitch overlay based on standard notes.

For example:

```text
A5  880 Hz
G5  783.99 Hz
F5  698.46 Hz
E5  659.25 Hz
D5  587.33 Hz
C5  523.25 Hz
```

Users can switch labels between:

- Note name + octave.
- Hz.
- Both.

Important: these are **visual guides**, not mandatory discrete positions.

A user should be able to drag between C5 and C#5 and settle on 552.17 Hz with no resistance.

---

# 11.1 Pitch-map modes

The map selector should be a first-class editor control:

```text
PITCH MAP   [ PIANO ] [ FREQUENCY ]
```

## Piano Map

The Piano Map is the composition-oriented view. It should show:

- Octave boundaries.
- Note lanes.
- Note names.
- Optional piano-key sidebar.
- Active scale degrees.
- Current tonic/root.
- Tuning target markers.
- Optional cents labels.

The Piano Map is not restricted to discrete pitches. A curve can travel continuously between note lanes.

## Frequency Map

The Frequency Map is the precision/analysis-oriented view. It should show:

- Raw Hz labels.
- Adaptive frequency ticks.
- Logarithmic or linear-Hz projection.
- Exact cursor frequency.
- Optional Piano/Scale Overlay.
- Optional JI target lines.

The frequency axis should remain visually honest: 500 Hz should be visibly twice 250 Hz in linear mode, while log mode represents ratios more naturally.

## Piano overlay on Frequency Map

When enabled, the Frequency Map can render a thin musical layer containing:

- 12-TET note lines.
- Active scale degrees.
- Tonic/root emphasis.
- Dynamic-JI targets.

The overlay is reference-only. Raw Hz remains the primary coordinate system and the user can still draw arbitrary frequencies.

---

# 11.2 Scale and tuning system

Scale and tuning must be data-model concepts rather than UI-only settings.

## Scale definition

```ts
interface ScaleDefinition {
	id: string;
	name: string;
	rootPitchClass: number;
	degrees: ScaleDegree[];
	octaveRatio: number;
}

interface ScaleDegree {
	degree: number;
	label: string;
	cents?: number;
	ratio?: { numerator: number; denominator: number };
}
```

Built-in scales should include at least:

- Chromatic.
- Major.
- Natural minor.
- Harmonic minor.
- Melodic minor.
- Major/minor pentatonic.
- Blues.
- Dorian.
- Phrygian.
- Lydian.
- Mixolydian.
- Locrian.

Users should also be able to create arbitrary scales from cents or rational ratios.

## Tuning definition

```ts
type TuningMode = '12tet' | 'equal-n' | 'static-ji' | 'dynamic-ji';

interface TuningDefinition {
	mode: TuningMode;
	referenceFrequencyHz: number;
	referencePitchClass: number;
	divisionsPerOctave?: number;
	jiRatios?: Ratio[];
	jiAnchorMode?: JIAnchorMode;
	jiPrimeLimit?: number;
}
```

---

# 11.3 Just Intonation

Support **Static JI** and **Dynamic JI** as real tuning modes.

## Static JI

Each degree resolves to a rational interval from the current root/reference. For example:

```text
1/1 = unison
5/4 = major third
3/2 = perfect fifth
2/1 = octave
```

The target frequency is:

```text
f_target = f_root × ratio × octaveFactor
```

Store numerator and denominator as integers and reduce them by GCD. Also display the equivalent cents value.

## Dynamic JI

Dynamic JI means that the ratio-based targets can change as the musical context changes over time. It should therefore be tied to the active Musical State and an explicit intonation anchor.

Supported anchors:

```text
Master Root
Manual Chord Root
Lowest Active Voice
Reference Track
Fixed Global Reference
```

For the initial implementation, **Master Root** and **Manual Chord Root** should be authoritative. Automatic chord detection should be deferred because a wrong automatic retune is worse than requiring the user to state the harmonic context.

Example:

```text
Beat 0–16: C major, dynamic JI
  E target = C × 5/4

Beat 16–32: D major, dynamic JI
  F# target = D × 5/4
```

The scale-relative target moves because the reference context moved; an absolute-Hz voice does not.

## Absolute Hz versus tuning-relative pitch

Every track should expose:

```text
PITCH INTERPRETATION
[ Absolute Hz ]
[ Scale-relative ]
```

Absolute-Hz curves are literal. Scale changes never rewrite them.

Scale-relative curves are interpreted through the active Musical State. Their stored coordinates should preserve the musical relationship needed to re-resolve the pitch when a scale/root/tuning keyframe changes.

This distinction is mandatory for safe dynamic JI behavior.

## JI visualization

When the active tuning differs from 12-TET, show the difference explicitly:

```text
A4 440.00 Hz     TET reference
JI target 440.00 Hz
JI deviation +0.00¢

E4 329.63 Hz     TET reference
JI target 330.00 Hz
JI deviation +1.95¢
```

Use a dedicated marker/line style for JI targets so users can distinguish them from ordinary note guides.

---

# 11.4 Scale settings UI

Add a compact Music/Tuning panel:

```text
ROOT          [ C ▼ ]
SCALE         [ Major ▼ ]
TUNING        [ Dynamic JI ▼ ]
REFERENCE     [ 440.00 Hz ]
JI ANCHOR     [ Master Root ▼ ]
PITCH MODE    [ Scale-relative ▼ ]

[ Edit Scale ] [ Edit Tuning ]
```

The scale editor should expose a degree matrix:

```text
Degree    1      2      3      4      5      6      7
Enabled   ✓      ✓      ✓      ✓      ✓      ✓      ✓
Ratio     1/1    9/8    5/4    4/3    3/2    5/3    15/8
Cents       0    204    386    498    702    884    1088
```

Editing a ratio updates its cents representation. Editing cents can optionally find a rational approximation, but exact-ratio mode must clearly distinguish an approximation from an exact fraction.

---

# 11.5 Master scale keyframes

The Master track should contain a dedicated **Musical State keyframe lane** above ordinary automation.

Example:

```text
0 bars                 16 bars                32 bars
│                      │                      │
◆ C Major / 12TET      ◆ D Minor / 12TET     ◆ C Major / Dynamic JI
```

Each keyframe may change:

- Root.
- Scale.
- Tuning mode.
- Reference frequency.
- JI ratio set.
- JI anchor.
- Pitch-snap policy.
- Absolute/scale-relative interpretation policy for newly created curves.

## Keyframe semantics

Discrete musical state changes should be step-based. Do not interpolate between arbitrary scales.

Continuous musical reference fields may optionally interpolate, but the default should remain step-based for predictable musical results.

A selected keyframe shows:

```text
MUSICAL STATE — beat 24
Root          A
Scale         Natural Minor
Tuning        Dynamic JI
Reference     440 Hz
JI Anchor     Master Root
Snap          Scale Degrees
```

Scale state is evaluated at the current playhead time. The same resolver is used for the Piano Map, Frequency Map overlay, snapping, inspector readouts, and future audio playback.

# 12. Snap system

Snapping needs to be powerful but easy to disable.

## Time snap options

- None.
- 1 beat.
- 1/2.
- 1/4.
- 1/8.
- 1/16.
- 1/32.
- Triplets.
- Dotted values.
- Bar.
- Custom ticks.

## Pitch snap options

- None.
- Nearest 12-TET note.
- Scale notes only.
- JI scale targets.
- Octave.
- User-defined scale.
- Exact Hz entry.

The target set is time-dependent when Musical State keyframes are present. At beat `t`, snapping should use `resolveMusicalState(project, t)` and then resolve the active tuning targets.

Example:

```text
Beat 8 → C major / Dynamic JI → snap to C, D, E, F, G... JI targets
Beat 24 → D minor / 12-TET    → snap to D, E, F, G, A... TET positions
```

Snapping should never alter a curve merely because the playhead crosses a scale-change keyframe. It only determines where editing gestures land, unless the user explicitly invokes a `Retune to Current Scale` command.

## Modifier behavior

Recommended:

- Snap normally.
- Hold Ctrl/Cmd to temporarily bypass snap.
- Hold Shift for constrained movement.
- Hold Alt/Option for fine adjustment.

This keeps the editor fast instead of forcing users to constantly open menus.

---

# 13. Selection model

Support:

- Single curve selection.
- Multi-select.
- Point selection.
- Region selection.
- Select all.
- Select all after playhead.
- Select all before playhead.

Use clear visual states:

```text
unselected = thin subdued line
selected   = bright/thicker line
hovered    = subtle preview halo
active     = points visible
playing    = animated/highlighted state
```

Do not rely solely on color; use thickness, handles, and markers too.

---

# 14. Curve editing tools

The tool palette should include:

- Select.
- Draw.
- Point edit.
- Eraser.
- Split.
- Join.
- Pan.
- Zoom.
- Automation.
- Measure/inspect.

Most users should spend most of their time with Select and Draw.

Tools should have obvious keyboard shortcuts and visible active states.

---

# 15. Time navigation

Horizontal navigation must feel unlimited.

Do **not** create a gigantic DOM element representing every possible beat.

Instead:

- maintain a scrollable viewport;
- use the scroll position as an approximate time anchor;
- render visible content with a transform;
- extend timeline bounds when content approaches the edge;
- allow the project duration to grow when users add content.

Useful controls:

- Mouse wheel = vertical/horizontal depending on modifiers.
- Shift + wheel = horizontal scroll.
- Ctrl/Cmd + wheel = zoom.
- Space = play/pause.
- Home = project start.
- End = last content.
- `Z` = zoom to selection.
- `Shift+Z` = zoom project.

---

# 16. Vertical navigation and frequency zoom

Frequency space should support both fixed project range and dynamic extension.

Default:

```text
20 Hz → 10,000 Hz
```

Controls:

- Scroll vertically.
- Zoom frequency axis.
- Center around cursor frequency.
- Min/max frequency controls.
- Reset view.

When the user zooms heavily into 430–470 Hz, grid labels should become correspondingly dense.

The same curve remains continuous; only its projection changes.

---

# 17. Timeline ruler

The top of the editor should show a timeline ruler.

At low zoom:

```text
0      4      8      12      16 bars
|------|------|-------|--------|
```

At high zoom:

```text
2.1      2.2      2.3      2.4
|---------|---------|---------|
```

Tick density should adapt to zoom level.

Do not draw thousands of labels.

Render only visible ticks.

---

# 18. Cursor readout

When the cursor is inside the editor, show:

```text
Beat: 12.375
Time: 00:05.800
Pitch: 734.41 Hz
Nearest note: F#5 + 18 cents
Scale degree: 5
JI target: 729.33 Hz
JI offset: +11.99 cents
```

Fields should be context-sensitive:

- Piano Map prioritizes note and scale information.
- Frequency Map prioritizes exact Hz.
- Dynamic JI adds target frequency and cents deviation.

This makes the continuous system understandable and useful for precise sound design.

---

# 19. Voice properties inspector

When a curve is selected, the right/left inspector should display the relevant settings.

Example:

```text
VOICE
────────────────────
Start     4.000 beat
End       8.500 beat

Envelope
Attack    10 ms
Decay     40 ms
Sustain   0.80
Release   100 ms

Pitch
Mode      Continuous
Start     220.00 Hz
End       277.18 Hz

Velocity / Level
Gain      -3.0 dB
Pan       0%
```

The inspector is for precision editing. The canvas remains the fast editing surface.

---

# 20. Per-track synthesis

Every MIDI-scroll-style track has an instrument/synth configuration.

Minimum source options:

- Sine.
- Triangle.
- Saw.
- Square.
- Pulse.
- White noise.
- Pink noise later.
- Custom wavetable.

The selector should look like a DAW instrument selector, not a giant list.

Each track also exposes a compact tuning relationship section:

```text
Pitch Mode: [Absolute Hz | Scale-relative]
Tuning Follow: [Master | Track override]
```

This determines whether the track responds to master Musical State keyframes and Dynamic JI.

Example:

```text
WAVE
[Sine ▼]

Preview waveform       ~~~~~
```

For custom wavetables:

```text
WAVE
[My Warm Bass Table ▼]
```

The selector should group presets:

```text
BASIC
  Sine
  Triangle
  Saw
  Square

NOISE
  White

USER
  Warm Bass
  Metallic Sweep
  My Table 3
```

---

# 21. Wavetable editor page

Create a dedicated route:

```text
/wavetables
```

The Wavetable page is a serious sound-design editor and should support **two different frame-authoring methods**:

```text
[ SHAPE EDITOR ] [ HARMONIC EDITOR ]
```

Both modes edit the same wavetable asset and frame list. They are different ways of constructing a frame, not separate wavetable formats.

## Overall layout

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Wavetable: Warm Motion     [Shape] [Harmonics]   [Save] [Duplicate]    │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│                         ACTIVE FRAME                                   │
│                    editor-specific canvas                              │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│ FRAME STRIP                                                            │
│  0%──────25%──────50%──────75%──────100%                               │
├────────────────────────────────────────────────────────────────────────┤
│ morph | preview | resolution | normalize | DC remove | phase          │
└────────────────────────────────────────────────────────────────────────┘
```

Do not place both editors side-by-side in the default layout. The controls are too dense. The mode tabs switch the main editing surface while preserving frame selection.

## Wavetable library

The library should support:

- New wavetable.
- Duplicate.
- Rename.
- Delete.
- Favorite.
- Search.
- Built-in presets.
- User-created tables.

Built-ins should include clean basic waves and several useful additive examples.

## Frame strip

Each wavetable contains keyframes distributed from `0.0` to `1.0`. Users can:

- Add frame.
- Duplicate frame.
- Delete frame.
- Move frame.
- Select frame.
- Set interpolation.
- Preview morph position.

Use a horizontal strip with draggable frame handles. Exact frame positions remain editable numerically.

# 22. Wavetable data model

The wavetable system must preserve an editable source representation and a cached sample representation. This is essential because the user can author the same frame by shape or by harmonics.

```ts
interface Wavetable {
	id: string;
	name: string;
	sampleLength: number;
	defaultInterpolation: 'linear' | 'smooth';
	frames: WavetableFrame[];
}

interface WavetableFrame {
	id: string;
	position: number;
	source: WavetableFrameSource;
	samples: Float32Array;
	interpolation: 'step' | 'linear' | 'smooth';
}

type WavetableFrameSource =
	{ kind: 'shape'; points: ShapePoint[] } | { kind: 'harmonics'; components: HarmonicComponent[] };
```

`source` is authoritative for editing. `samples` is a generated cache.

Do not silently force a shape-authored frame into a harmonic representation. Provide explicit `Convert to Harmonics` and `Convert to Shape` commands and warn that conversions can be lossy.

# 23. Wavetable keyframe workflow

Allow users to:

- Add keyframe.
- Duplicate keyframe.
- Delete keyframe.
- Move keyframe.
- Draw/edit frame.
- Preview morphing.
- Choose interpolation.
- Normalize.
- DC-remove.
- Reverse.
- Invert.
- Phase-rotate.

Example:

```text
Frame 0%        sine
Frame 25%       soft saw
Frame 50%       pulse-like
Frame 75%       complex harmonic frame
Frame 100%      sine
```

For shape frames, interpolate waveform samples or shape points according to the selected interpolation method. For harmonic frames, interpolate component parameters according to the Harmonic Editor rules below.

Amplitudes interpolate numerically. Phases use shortest-path angular interpolation. Discrete waveform-source types are crossfaded rather than numerically interpolated.

# 24. Wavetable Shape Editor

The Shape Editor is the direct waveform drawing surface.

## Main canvas

Show one wrapped waveform cycle:

```text
+1 ─────────────────────────────────────────────
      ╭────╮                    ╭──╮
     ╱    ╲____              ___╯  ╲
0 ─────────────────────────────────────────────

-1 ─────────────────────────────────────────────
      0°                                     360°
```

X = phase from 0° to 360°. Y = normalized amplitude from -1 to +1.

Support:

- Freehand draw.
- Point edit.
- Line segment.
- Smooth.
- Sharpen.
- Mirror horizontally.
- Mirror vertically.
- Invert.
- Reverse phase.
- Remove DC.
- Peak normalize.
- RMS normalize.

Expose sample lengths such as 256, 512, 1024, 2048, 4096, and 8192 samples per frame. The displayed source can remain a compact editable curve while generation uses the chosen table resolution.

Provide optional zero-crossing, half-wave symmetry, quarter-wave symmetry, seam/phase-wrap, and endpoint locking helpers.

# 24.1 Wavetable Harmonic Editor

The Harmonic Editor constructs a frame from an additive spectrum. It should feel like a specialized spectral control surface rather than another waveform painter.

## Core representation

Each column represents one harmonic of the frame's base frequency:

```text
H1 = 1/1
H2 = 2/1
H3 = 3/1
H4 = 4/1
...
```

```ts
interface HarmonicComponent {
	harmonic: number;
	waveform: 'sine' | 'saw' | 'square' | 'triangle';
	amplitude: number;
	phaseRadians: number;
	enabled: boolean;
}
```

## Exact vertical control hierarchy

Every harmonic column must use the same control ordering from top to bottom:

```text
           ┌─────────────┐
           │ amplitude   │  ← vertical slider
           │      │      │
           │      │      │
           │      ●      │  ← phase knob
           │             │
           │    [SINE]   │  ← waveform selector/toggle
           │             │
           │     3/1     │  ← harmonic fraction/ratio
           └─────────────┘
```

The **fraction/ratio is always at the very bottom** of the column. The harmonic number (`H3`) is secondary and may appear above the amplitude control.

## Waveform selector

Each column can independently use:

```text
SINE
SAW
SQUARE
TRIANGLE
```

Use a compact cyclic/segmented control instead of four large buttons. With 32–64 harmonics, four full buttons per column would make the editor unusable.

## Phase control

Place a rotary knob directly above the waveform selector.

Range:

```text
0° … 360°
```

Support vertical drag, Shift fine adjustment, wheel adjustment, double-click reset, and numeric hover/selection readout.

## Amplitude control

Place a vertical slider/strip above the phase knob. Display a normalized amplitude percentage in the compact view, with optional dB in the inspector.

Support coarse drag, Shift fine drag, double-click reset, and numeric readout while selected.

## Fundamental placement and workspace proportions

The fundamental should be **prominent but intentionally left-biased**. Put H1 at roughly **20–25% of the visible harmonic-grid width**, not at 50%.

There are no normal harmonic columns below H1, so a symmetrical layout would waste half the editing surface. Reserve more room to the right for H2–H64.

Conceptually:

```text
┌──────────── utility ───────────┬──────────────────────────────────────┐
│ frame / preview / tools        │ H1 H2 H3 H4 H5 H6 H7 H8 ... H64     │
│                                │ 1/1 2/1 3/1 4/1 5/1 6/1 ...        │
└────────────────────────────────┴──────────────────────────────────────┘
```

The harmonic workspace is horizontally scrollable and zoomable. H1 should remain easy to locate.

## Harmonic ratio labels

The bottom label is the spectral identity:

```text
H1 → 1/1
H2 → 2/1
H3 → 3/1
...
```

For v1, only positive integer harmonics are supported. The fraction/ratio terminology deliberately leaves room for future inharmonic/rational partial features.

## Harmonic count

Presets:

```text
8
16
32
64
128 (advanced)
```

Sparse harmonic sets are allowed. Disabled components should be cheap to store and render.

## Preview

Show two synchronized previews:

```text
TIME-DOMAIN WAVEFORM
~~~~~~ complex shape ~~~~~~

SPECTRUM
H1 ██████████
H2 ███████
H3 ████
H4 ██
...
```

Changing a column updates both previews immediately.

## Waveform semantics

A column is a component centered at `n × f0`. Sine is a single sinusoidal component at that harmonic.

For saw, square, and triangle, do **not** let the selected column recursively create other editor columns. A saw on H5 must not secretly create H10/H15/H20 components that the user cannot see.

Instead, render the selected periodic source at `n × f0`, band-limited appropriately, then apply its amplitude and phase before summing it with other columns.

## Aliasing protection

The final audio engine must band-limit every selected component to Nyquist. Preview generation should also avoid obviously aliased sources.

## Spectrum utilities

Provide:

```text
Clear All
Normalize
Randomize Amplitudes
Randomize Phases
Reset Phases
Keep Odd
Keep Even
Apply Spectral Tilt
Apply Exponential Rolloff
Copy Spectrum
Paste Spectrum
Duplicate Frame Spectrum
```

Default target = active frame. An explicit `All Selected Frames` option is required for destructive batch edits.

## Harmonic morphing

Between harmonic-authored frames:

- Amplitude → linear/smooth interpolation.
- Phase → shortest-angle interpolation.
- Missing harmonic → fade from/to zero.
- Waveform type → discrete; crossfade the rendered component outputs when smooth morphing is selected.

Never interpolate the waveform enum itself.

## Harmonics → Shape and Shape → Harmonics

Provide explicit conversion actions:

```text
Convert Harmonics → Shape
Analyze Shape → Harmonics
```

`Harmonics → Shape` can be deterministic because it synthesizes the frame. `Analyze Shape → Harmonics` should be labeled approximate and should expose analysis resolution/window settings later.

Conversions should not happen automatically when switching editor tabs.

## Harmonic editor performance

Use standard HTML/Svelte controls for columns, knobs, and sliders. Use canvas for waveform and spectrum previews.

Virtualize/clip off-screen columns so 128-harmonic tables remain responsive.

# 25. Wavetable preview

The wavetable page should include:

- Note selector.
- Preview frequency.
- Preview duration.
- Morph position slider.
- LFO morph preview.
- Play/stop.

When live audio is eventually implemented, this preview should use exactly the same synthesis code as project playback.

Do not build a separate “preview synth” implementation.

---

# 26. Wavetable automation

A track should have a parameter named something like:

```text
Wavetable Position: 0..1
```

This can be controlled by:

- Fixed value.
- Per-voice envelope.
- LFO.
- Track automation.
- Master automation.

The Wavetable Position parameter must work identically for tables created by the Shape Editor and Harmonic Editor. The synth should see both as normalized frame collections.

The harmonic editor also makes future spectral modulation possible, but do not expose a separate harmonic-by-harmonic automation lane in v1. Use Wavetable Position first; per-harmonic automation is a later advanced feature.

This creates a powerful distinction:

```text
Pitch curve = where the oscillator is in frequency.
Wavetable position = where the oscillator is in timbre.
Automation = how other parameters evolve over time.
```

Keep these concepts visually separate.

---

# 27. LFO system

Each track should have a compact modulation section.

Minimum LFO waveforms:

- Sine.
- Triangle.
- Saw up.
- Saw down.
- Square.
- Random/sample-and-hold later.

Parameters:

```text
LFO 1
Rate:       2.00 Hz
Sync:       1/4
Wave:       Sine
Phase:      0°
Amount:     20%
Destination: [Wavetable Position ▼]
```

Destinations should include:

- Pitch offset.
- Volume.
- Pan.
- Filter cutoff.
- Resonance.
- Wavetable position.
- Drive.
- Delay mix.
- Reverb mix.

Provide multiple LFO slots later rather than building a complicated modulation matrix on day one.

---

# 28. Automation engine

Automation should be parameter-based and generic.

Example:

```ts
interface AutomationLane {
	id: string;
	target: ParameterTarget;
	points: AutomationPoint[];
}

interface AutomationPoint {
	time: number;
	value: number;
	interpolation: 'step' | 'linear' | 'smooth' | 'bezier';
}
```

The same engine should power:

- Volume automation.
- Filter cutoff.
- Resonance.
- Pan.
- Wavetable position.
- LFO amount.
- Effects mix.
- Future parameters.

Do not hardcode separate curve editors for each automation parameter.

---

# 29. Automation UI

Automation should appear in expandable lanes underneath the main curve editor.

Example:

```text
MAIN CURVES
──────────────────────────────
        ╭──── pitch curve ──╮
───────╯                    ╰────

AUTOMATION
Volume        ─────╮______╭──────
Filter Cutoff ──╮───────────────
WT Position    ─────╱╲──────────
```

Collapsed state:

```text
[Automation ▸]
```

Expanded state:

```text
[Automation ▾]
Volume       [curve]
Filter Cut   [curve]
WT Position  [curve]
```

This preserves screen space.

---

# 30. Track parameter organization

Avoid a giant synth panel.

Use categories:

```text
SOURCE
  Waveform
  Wavetable position

PITCH
  Base offset
  Fine tune

AMPLITUDE
  Gain
  Envelope
  Pan

FILTER
  Type
  Cutoff
  Resonance

MODULATION
  LFO 1
  LFO 2

FX
  Drive
  Delay
  Reverb
```

Each section can collapse.

---

# 31. Track-level mixer controls

Every track tab should support fast controls:

```text
Track 1    M  S
Volume     ━━━━━━━━━━
Pan        ━━━●━━━━
```

Keep mute/solo easy to hit.

Do not hide them inside a menu.

---

# 32. Playback architecture for the future

Even though audio playback is not required in the first version, the data model should already support it.

Suggested audio graph:

```text
Project clock
     │
     ├── Track 1 voice scheduler
     │       └── oscillator/custom wavetable
     │             └── envelope
     │                 └── filter
     │                     └── track bus
     │
     ├── Track 2 voice scheduler
     │       └── ...
     │
     └── Master bus
             ├── master automation
             ├── master effects
             └── output
```

Use `AudioWorklet` for custom oscillators and other high-rate DSP where appropriate rather than relying on the Svelte/UI thread. [MDN AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)

The UI should communicate parameter changes to the audio engine through a dedicated bridge.

Never make the DOM/canvas render loop responsible for audio timing.

---

# 33. Playback scheduling

When playback is implemented, use an audio-clock-based scheduler.

Do not schedule oscillators directly from animation frames.

The visual playhead follows audio time; audio time does not follow the visual frame rate.

Recommended model:

```text
Audio engine clock
      ↓
current project time
      ↓
UI playhead interpolation
```

This avoids drift caused by rendering load.

---

# 34. Future export architecture

The editor should eventually have:

```text
Export
├── WAV
├── 32-bit float WAV
├── 24-bit WAV
├── 16-bit WAV
└── future formats
```

Offline rendering can use `OfflineAudioContext`, which is specifically intended to render an audio graph into an `AudioBuffer` rather than the hardware output. [MDN OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext)

Export flow:

```text
ProjectState
    ↓
Renderer
    ↓
OfflineAudioContext / custom DSP
    ↓
AudioBuffer
    ↓
WAV encoder
    ↓
Blob
    ↓
download
```

Keep export completely separate from the editor UI.

---

# 35. Local persistence

The application should save automatically.

## Store in persistent project state

- Tracks.
- Curves.
- Automation.
- Tempo.
- Time signature.
- Markers.
- Mixer settings.
- Wavetable references.
- Custom wavetables.

## localStorage

Best used for:

- UI preferences.
- Last project ID.
- Theme.
- Snap settings.
- Zoom settings.
- Recently used waves.
- Compact custom wavetable definitions.

## IndexedDB

Use for:

- Large projects.
- Large wavetable collections.
- Future rendered previews.
- Future audio assets.

Wrap persistence behind one API:

```ts
interface ProjectStorage {
	save(project: Project): Promise<void>;
	load(id: string): Promise<Project | null>;
	delete(id: string): Promise<void>;
	list(): Promise<ProjectSummary[]>;
}
```

Then the UI does not care whether storage is localStorage or IndexedDB.

---

# 36. Undo/redo

This is essential.

Do not implement undo as random component-level state snapshots.

Use command-based or immutable state transitions.

Examples:

```text
CreateCurveCommand
MovePointCommand
DeletePointCommand
ChangeWaveCommand
AddAutomationPointCommand
DeleteTrackCommand
ChangeTempoCommand
```

Each command should have:

```ts
execute();
undo();
```

For large projects, consider snapshot checkpoints plus command deltas.

The user should be able to undo essentially every editing operation.

Keyboard:

- Cmd/Ctrl + Z
- Cmd/Ctrl + Shift + Z

---

# 37. Copy/paste/duplicate

Support:

- Copy curve.
- Paste relative to playhead.
- Duplicate with time offset.
- Duplicate track.
- Copy automation lane.
- Copy selected points.
- Paste parameter settings.

This is necessary for actual music production.

---

# 38. Quantization and transforms

Useful commands:

- Quantize selected start/end times.
- Quantize points.
- Transpose selected curves by semitone.
- Shift pitch by exact Hz.
- Scale frequency around a reference.
- Stretch time.
- Compress time.
- Reverse curve.
- Mirror pitch around a frequency.
- Normalize timing.

Example:

```text
Transform
────────────
Time scale: 1.00x
Pitch scale: 1.00x
Pitch offset: +0 semitones
Anchor: Start
[Apply]
```

These make the continuous editor much more powerful than a basic drawing tool.

---

# 39. Markers and structure

Allow timeline markers:

- Intro.
- Verse.
- Chorus.
- Drop.
- Transition.
- Custom labels.

Marker bar:

```text
0       16       32       48
|-------|--------|--------|
Intro   Verse    Chorus
```

Later these can be used for loop ranges and navigation.

---

# 40. Looping

Support loop region:

```text
        ┌─────────────────────┐
        │       LOOP AREA      │
────────┴─────────────────────┴────────
```

Controls:

- Loop toggle.
- Set loop start.
- Set loop end.
- Drag boundaries.
- Loop selected region.

This becomes particularly useful while editing curves and wavetable modulation.

---

# 41. Context menus

Right-click a curve:

```text
Edit
──────
Add point
Split
Join
Duplicate
Delete

Transform
─────────
Quantize
Transpose
Stretch
Reverse

Properties
```

Right-click a point:

```text
Set exact Hz
Set exact beat
Change interpolation
Delete point
```

Right-click an empty timeline region:

```text
Create curve
Add marker
Paste
Set loop start
```

---

# 42. Keyboard shortcut system

Target a DAW-like power-user workflow.

Suggested baseline:

```text
Space           Play/Pause
Enter           Play from selection
Esc             Cancel current action
Delete/Backspace Delete
Cmd/Ctrl+Z      Undo
Cmd/Ctrl+Shift+Z Redo
Cmd/Ctrl+C      Copy
Cmd/Ctrl+V      Paste
Cmd/Ctrl+D      Duplicate
A               Select tool
P               Pen/draw tool
E               Eraser
S               Split
G               Snap toggle
H               Pan
Z               Zoom selection
Shift+Z         Zoom project
Tab             Next track
Shift+Tab       Previous track
```

The exact shortcut map can change, but it should be documented in an in-app shortcut panel.

---

# 43. Interaction precision

Continuous pitch editing creates a precision problem.

A 100 Hz visual movement may represent a very small musical change at 100 Hz and a massive one at 9 kHz.

Therefore:

- Use logarithmic pitch coordinates by default.
- Show exact Hz near the cursor.
- Support keyboard nudging.
- Support fine-control modifiers.
- Support direct numeric entry.

For point movement:

```text
Arrow key       small pitch/time increment
Shift + Arrow   larger increment
Alt + Arrow     very fine increment
```

The exact increment should depend on zoom and snap mode.

---

# 44. Visual hierarchy

The UI should feel like a serious creative application, not a generic web dashboard.

Recommended visual hierarchy:

1. Curves/playhead.
2. Timeline/frequency grid.
3. Selection handles.
4. Track identity.
5. Controls.
6. Secondary metadata.

Avoid excessive card borders.

Avoid gradients everywhere.

Avoid huge empty margins.

Use a dense dark interface with restrained contrast and strong focus states.

---

# 45. Color strategy

Use a neutral dark workspace.

Assign each track a distinctive accent color.

Important rule: accent color should communicate track identity, not parameter magnitude.

Automation lanes can use variations of the track accent or a neutral color system with distinct lane labels.

Selected objects should also receive a non-color indicator, such as a brighter stroke and visible handles.

---

# 46. Canvas rendering architecture

Use Canvas 2D for the editor itself.

Do not render thousands of SVG nodes if projects become large.

Suggested canvas stack:

```text
Canvas 1: background/grid
Canvas 2: curve paths
Canvas 3: overlays/playhead/selection
HTML: controls, tooltips, inspector, menus
```

The canvas can be a single composited surface if performance is sufficient, but separating static and dynamic layers can reduce redraw work.

---

# 47. Rendering optimization

Only render what is visible.

For every frame:

1. Determine visible time range.
2. Determine visible frequency range.
3. Find curves intersecting that region.
4. Draw only relevant geometry.
5. Avoid recomputing curve sampling when neither the curve nor viewport changed.

Cache sampled curve geometry at useful zoom levels.

Invalidate caches only when:

- Curve changes.
- Zoom changes enough to require resampling.
- Frequency scale changes.
- Time scale changes.

---

# 48. Pointer performance

Pointer movement can occur hundreds of times per second.

Do not trigger a full Svelte component tree update for every pointer event.

During dragging:

```text
pointer event
    ↓
editor interaction controller
    ↓
mutable drag preview
    ↓
canvas redraw
```

Commit the final edit to the project command/state system on release, or use a throttled transaction model.

This is especially important for drawing curves.

---

# 49. Svelte component architecture

Suggested structure:

```text
src/
  lib/
    model/
      project.ts
      track.ts
      curve.ts
      automation.ts
      wavetable.ts
      parameters.ts

    editor/
      viewport.ts
      coordinateTransform.ts
      snapping.ts
      hitTesting.ts
      curveSampling.ts
      curveDrawing.ts
      gestures.ts

    audio/
      audioEngine.ts
      scheduler.ts
      synth.ts
      wavetableOscillator.ts
      dsp/

    persistence/
      projectStorage.ts
      localStorageStore.ts
      indexedDbStore.ts

    history/
      command.ts
      historyManager.ts

    ui/
      theme.ts
      shortcuts.ts

  components/
    AppShell.svelte
    TopBar.svelte
    Transport.svelte
    TrackTabs.svelte
    TrackInspector.svelte
    CurveEditor.svelte
    TimelineRuler.svelte
    FrequencyRuler.svelte
    AutomationPanel.svelte
    AutomationLane.svelte
    TrackMixer.svelte
    WaveSelector.svelte
    ContextMenu.svelte
    CommandPalette.svelte

  routes/
    +page.svelte
    wavetables/
      +page.svelte
    settings/
      +page.svelte
```

Use Svelte components for UI composition and imperative TypeScript modules/classes for geometry, interaction, and audio-heavy logic.

Do not put the curve math inside `.svelte` files.

---

# 50. State design with Svelte

Use Svelte 5 runes for reactive UI state where appropriate.

Example conceptual layout:

```ts
let project = $state<Project>(createDefaultProject());
let selectedTrackId = $state<string>('master');
let selectedIds = $state<string[]>([]);
let viewport = $state<ViewportState>(defaultViewport());
```

But keep the data/model logic in plain TypeScript modules.

Derived values can use computed/reactive mechanisms, while high-frequency canvas interaction should stay outside normal component reactivity.

---

# 51. Routing

Suggested routes:

```text
/                 Main editor
/wavetables       Wavetable library/editor
/scales           Scale + tuning library/editor
/settings         Preferences
/help             Shortcuts / help
```

The `/scales` page should provide the reusable scale definitions and JI ratio libraries used by Musical State keyframes. It should not replace the quick inline controls in the main editor.

The application should remain usable if JavaScript is temporarily unavailable at the marketing/help pages, but the editor itself necessarily depends on client-side JavaScript.

Build it as a static client application. SvelteKit's static adapter is appropriate for this deployment model. [Svelte package listing](https://svelte.dev/packages)

---

# 51.1 Musical state data model

Store the master musical context explicitly:

```ts
interface MusicalStateKeyframe {
	id: string;
	time: number;
	state: MusicalState;
}

interface MusicalState {
	rootPitchClass: number;
	scaleId: string;
	tuning: TuningDefinition;
	snapMode: 'none' | 'note' | 'scale' | 'ji';
	defaultPitchRepresentation: 'absolute-hz' | 'scale-relative';
}
```

The master track contains:

```ts
interface MasterTrack {
	musicalState: MusicalStateKeyframe[];
	automationLanes: AutomationLane[];
}
```

Centralize resolution:

```ts
resolveMusicalState(project, beat) -> MusicalState
resolveScaleTargets(state) -> PitchTarget[]
resolvePitchTarget(state, degree, octave) -> number
```

Every subsystem must consume these shared functions: Piano Map, Frequency Map overlay, snapping, inspector readouts, and future audio playback.

## JI validation

- Ratio numerator and denominator must be positive integers.
- Reduce ratios by GCD.
- Reject zero/negative ratios.
- Keep prime-limit and ratio-complexity settings bounded.
- Preserve exact integer ratios rather than only storing decimal cents.

# 52. Project file model

Even before export/import exists, define a serializable project schema.

Example:

```ts
interface Project {
	version: number;
	id: string;
	name: string;
	tempo: number;
	timeSignature: {
		numerator: number;
		denominator: number;
	};
	durationBeats: number;
	editorSettings: EditorSettings;
	tracks: Track[];
	master: MasterTrack;
	wavetables: Wavetable[];
	scales: ScaleDefinition[];
	markers: Marker[];
}

interface EditorSettings {
	pitchMap: 'piano' | 'frequency';
	frequencyProjection: 'logarithmic' | 'linear-hz';
	showPianoOverlay: boolean;
	snapTime: SnapTimeMode;
	snapPitch: SnapPitchMode;
}
```

Use explicit schema versioning.

This is critical because the data format will evolve.

---

# 53. Future project export/import

Eventually provide:

```text
File
├── Save Project
├── Save As
├── Open Project
├── Export WAV
└── Export Stems
```

Project file could eventually be:

```text
.lineproj
```

Containing:

```text
project.json
wavetables/
  table-1.bin
  table-2.bin
assets/
```

A ZIP-based container would be practical later.

---

# 54. Browser/static constraints

Because the app is static:

- No backend is required for normal operation.
- No user login is required.
- All project state stays on the device unless the user exports it.
- Hosting can be a normal static hosting provider.
- Any future audio processing should be local in the browser.

Potential issue: custom AudioWorklet code and some Web Audio functionality require secure contexts in browsers, so the production deployment should be HTTPS. [MDN AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)

---

# 55. Responsive behavior

This should be **desktop-first**, not mobile-first.

The editor needs:

- Large horizontal canvas.
- Precise pointer editing.
- Dense controls.
- Many simultaneous tracks/layers.

Minimum target:

```text
1280 × 720
```

Recommended:

```text
1440p+
```

On smaller screens:

- Collapse inspector.
- Collapse secondary toolbars.
- Keep editor and track tabs usable.
- Provide horizontal tab scrolling.

Do not attempt to force the full desktop UI into a phone-sized layout.

---

# 56. Accessibility

Even for a highly visual application:

- Keyboard focus states.
- ARIA labels for controls.
- Tooltip text for icon-only controls.
- Keyboard-accessible track switching.
- Numeric fields for exact parameter entry.
- Avoid color-only state indicators.
- Support reduced motion for animated UI.

Canvas controls need an accessible HTML companion layer for important actions.

---

# 57. Error handling

The app should never silently lose a project.

Examples:

```text
Storage full
Could not save project
[Retry] [Export Backup]
```

If a malformed saved project is detected:

```text
This project was created by a newer version.
Open read-only / Attempt migration / Cancel
```

Always keep a recent autosave snapshot where practical.

---

# 58. Project autosave strategy

Suggested behavior:

- Mark project dirty on mutation.
- Debounce autosave.
- Save after a short idle period.
- Save immediately on major destructive operations.
- Save a small recovery snapshot periodically.

Top bar should show:

```text
Saved
Saving…
Unsaved changes
```

Do not save on every pointer event.

---

# 59. Performance targets

Target:

- Smooth interaction at 60 FPS for normal projects.
- No visible lag while dragging points.
- No full-project redraw on every minor UI change.
- Fast track switching.
- Instant selection feedback.
- Graceful degradation with very large projects.

Useful stress-test cases:

```text
10 tracks × 100 curves
10 tracks × 1,000 curves
100 automation lanes
10,000 total control points
Large custom wavetable library
```

The application should remain usable even if some expensive operations degrade gracefully.

---

# 60. Testing strategy

## Unit tests

Test pure functions:

- Time ↔ pixel conversion.
- Hz ↔ pixel conversion.
- Piano Map projection.
- Frequency Map log projection.
- Frequency Map linear-Hz projection.
- Note ↔ Hz conversion.
- Scale-degree target generation.
- Rational JI interval calculation.
- Dynamic JI anchor resolution.
- Musical State keyframe resolution.
- Absolute-Hz versus scale-relative pitch resolution.
- Curve interpolation.
- Curve simplification.
- Hit testing.
- Snapping.
- Automation interpolation.
- Wavetable interpolation.
- Harmonic component synthesis.
- Harmonic phase interpolation.
- Waveform crossfading.
- Project serialization.

## Interaction tests

Test:

- Draw curve.
- Add point.
- Move point.
- Delete point.
- Select multiple curves.
- Copy/paste.
- Undo/redo.
- Track switching.
- Wavetable creation.
- Autosave/reload.

## Visual regression tests

Capture reference screenshots for:

- Empty project.
- One curve.
- Dense curves.
- Automation open.
- Wavetable editor.
- Zoomed-in pitch editing.

---

# 61. Development phases

## Phase 1 — Skeleton

Build:

- SvelteKit static project.
- App shell.
- Top bar.
- Bottom track tabs.
- Main editor canvas.
- Basic project state.
- Routing.

No audio.

Deliverable: a believable DAW UI shell.

## Phase 2 — Core curve editor

Implement:

- Separate Piano Map and Frequency Map.
- Frequency Map log projection.
- Frequency Map linear-Hz projection.
- Optional piano overlay.
- Dynamic horizontal timeline.
- Continuous pitch curves.
- Editable control points.
- Bezier/smooth interpolation.
- Selection.
- Hit testing.
- Time snapping.
- Basic pitch snapping.
- Zoom/pan.
- Undo/redo.

This is the true editor MVP.

## Phase 3 — Musical state and tuning

Implement:

- Scale library.
- Custom scale editor.
- Root settings.
- 12-TET.
- Static JI.
- Dynamic JI.
- JI ratios and cents display.
- JI anchor modes.
- Absolute-Hz and scale-relative pitch modes.
- Master Musical State keyframes.
- Time-dependent snapping.
- Tuning target overlays.

Before moving on, test scale changes extensively so they cannot unexpectedly modify absolute-Hz curves.

## Phase 4 — Track system

Implement:

- Create/delete/rename tracks.
- Track tabs.
- Per-track wave selector.
- Per-track inspector.
- Mute/solo/volume/pan data.
- Per-track pitch interpretation mode.
- Persistent project state.

## Phase 5 — Automation

Implement:

- Generic automation lane system.
- Volume.
- Filter cutoff.
- Resonance.
- Pan.
- Wavetable position.
- Master parameter automation.

## Phase 6 — Wavetable system

Implement both authoring surfaces:

- Wavetable library.
- Shape Editor.
- Harmonic Editor.
- Keyframe/frame strip.
- Per-frame shape source.
- Per-frame harmonic source.
- Harmonic column waveform selector.
- Per-harmonic phase knob.
- Per-harmonic amplitude slider.
- Ratio/fraction labels.
- Harmonic preview.
- Wavetable morphing.
- Normalization.
- DC removal.
- local persistence.

## Phase 7 — LFO/modulation

Implement:

- LFOs.
- Sync modes.
- Destination selection.
- Wavetable position modulation.
- Track automation interactions.

## Phase 8 — Audio playback

Implement:

- Web Audio engine.
- Custom oscillator.
- Band-limited wavetable playback.
- Harmonic-source rendering.
- Dynamic-JI pitch resolution.
- Voice scheduler.
- Envelope.
- Filter.
- Track buses.
- Master bus.
- AudioWorklet where beneficial.

## Phase 9 — Export

Implement:

- Offline rendering.
- WAV encoding.
- Full mix export.
- Optional stems.
- Progress UI.

# 62. MVP feature cut

The first genuinely usable release should contain:

```text
✓ Static Svelte build
✓ Project persistence
✓ Track tabs
✓ Continuous pitch curves
✓ Editable control points
✓ Bezier/smooth curves
✓ Separate Piano Map and Frequency Map
✓ Frequency Map logarithmic projection
✓ Frequency Map linear-Hz option
✓ Piano overlay on Frequency Map
✓ Up to 10 kHz default range
✓ Dynamic horizontal timeline
✓ Time snapping
✓ 12-TET note snapping
✓ Scale snapping
✓ Scale/root settings
✓ Master Musical State keyframes
✓ Static Just Intonation
✓ Dynamic Just Intonation
✓ Absolute-Hz and scale-relative pitch modes
✓ JI target visualization
✓ JI cents deviation readout
✓ Undo/redo
✓ Copy/paste/duplicate
✓ Track waveform selector
✓ Built-in oscillator presets
✓ Master track
✓ Generic automation lanes
✓ Wavetable library
✓ Shape-based wavetable editor
✓ Wavetable frame keyframes
✓ Harmonic-based wavetable editor
✓ Per-harmonic sine/saw/square/triangle selector
✓ Per-harmonic phase control
✓ Per-harmonic amplitude control
✓ Harmonic ratio/fraction labels
✓ Wavetable frame morphing
✓ local persistence for wavetables
✓ Basic LFO data model / UI
```

Playback and export still may wait, but the project model must already support them.

# 63. Features that should wait

Avoid adding these early:

- MIDI import/export.
- Plugin formats.
- Audio recording.
- Spectrogram editing.
- Advanced modular synthesis.
- Multiplayer.
- Cloud accounts.
- AI generation.
- Complex node-based modulation graphs.

They could consume huge amounts of engineering time without improving the defining experience.

---

# 64. The defining UX loop

The product should optimize this exact sequence:

```text
Create track
    ↓
Choose wave
    ↓
Draw pitch line
    ↓
Add a few curvature points
    ↓
Press play
    ↓
Hear continuous pitch movement
    ↓
Adjust curve
    ↓
Automate filter / wavetable position
    ↓
Repeat
```

Anything that slows this loop should be questioned.

---

# 65. Example editing session

A user wants a rising laser-like synth sound.

1. Create a track named `Laser`.
2. Select `Saw`.
3. Draw a curve from 180 Hz at beat 0 to 6,000 Hz at beat 4.
4. Add a point at beat 2 and pull it downward so the pitch rises slowly, then accelerates.
5. Add filter-cutoff automation that rises with the curve.
6. Open the wavetable editor.
7. Create a wavetable with three keyframes: sine → narrow pulse → bright complex waveform.
8. Return to the track.
9. Select the custom wavetable.
10. Add a synchronized LFO to wavetable position.
11. Return to the master track.
12. Automate global volume around the transition.

This is the experience the UI should make feel natural.

---

# 66. Advanced future ideas

Once the core workflow is strong, the architecture can support more unusual features.

## Advanced intonation

Possible later additions:

- Automatic chord-root inference for Dynamic JI.
- User-defined prime-limit libraries.
- Historical temperaments.
- Meantone and well temperaments.
- Scala `.scl` import.
- Per-voice intonation anchors.
- Voice-leading-aware JI retuning.
- Hysteresis to prevent rapid retuning during ambiguous chords.

Dynamic JI should eventually support a user-configurable **retuning response time** so an active pitch does not jump when harmonic context changes unless the user wants it to.

## Advanced harmonic synthesis

Possible later additions:

- Automatic FFT analysis of a shape-authored frame.
- Spectral envelope drawing.
- Formant regions.
- Harmonic groups.
- Inharmonic partials.
- Individual harmonic automation.
- Spectral morph targets.
- Per-harmonic LFOs.

## Pitch-curve quantization

Select a curve and quantize only its local minima/maxima or selected points to a scale while preserving the glide between them.

## Pitch expression tools

Commands like:

- Vibrato.
- Portamento.
- Tremolo.
- Exponential rise.
- Exponential fall.
- S-curve.
- Bounce.
- Pulse staircase.

These could generate curve shapes from parameters rather than manual drawing.

## Curve brush

Paint pitch modulation over an existing path.

## Relative curve editing

Lock the overall trajectory and move only local sections.

## Spectral/wavetable visualization

Show approximate harmonic content alongside waveform shape.

## Per-voice effects

Allow a voice to have its own envelope/filter/modulation settings.

## Macro controls

Expose a small number of high-level macros:

```text
Brightness
Movement
Width
Aggression
Texture
```

These can drive multiple parameters at once.

---

# 67. Suggested visual language

Use a modern dark production-tool aesthetic.

Characteristics:

- Nearly-black blue/gray background.
- Thin separators.
- Compact toolbar.
- Medium-density controls.
- Rounded controls only where they improve grouping.
- Bright accent for active track.
- Clear hover states.
- Minimal visual noise.
- Monospaced numeric readouts where precision matters.
- Sans-serif labels elsewhere.

The editor should have a larger contrast range than surrounding chrome so the actual sound representation is visually dominant.

---

# 68. Recommended first screen

When the app opens for the first time:

```text
┌────────────────────────────────────────────────────────────┐
│ Line Synth                                  120 BPM       │
│                                                            │
│                 Start creating                            │
│                                                            │
│           Draw a curve to create a voice                   │
│                                                            │
│                 [Create Track]                             │
│                                                            │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ MASTER                                  [+ Track]           │
└────────────────────────────────────────────────────────────┘
```

After a track exists, the editor becomes the default screen and should not show onboarding again unless requested.

---

# 69. Important engineering decisions

### Decision 1: Canvas over DOM for the core editor

The central timeline can become extremely dense. Canvas gives direct control over rendering and avoids huge numbers of DOM nodes.

### Decision 2: Continuous model coordinates

Never represent pitch as MIDI note number internally. MIDI note numbers can be derived for display/snap purposes.

### Decision 3: Logarithmic pitch display

This matches how musicians perceive pitch intervals and makes a 20 Hz–10 kHz workspace manageable.

### Decision 4: Generic automation

Automation is a system for parameter curves, not separate widgets for volume/filter/etc.

### Decision 5: Shared curve mathematics

Use the same interpolation utilities for pitch curves and automation curves when their semantics match.

### Decision 6: UI/audio separation

Svelte controls should never be the audio timing system.

### Decision 7: Persistence abstraction

Do not bind the whole application to localStorage just because the initial requirement is local persistence.

---

# 70. Definition of done for the core editor

The core editor is successful when a user can open the static site and, without reading documentation:

1. Create a track.
2. Pick a waveform.
3. Draw a pitch trajectory.
4. Add and move points.
5. Zoom from a large musical overview to precise pitch editing.
6. Snap timing without accidentally forcing pitch.
7. Switch tracks without losing context.
8. Automate at least volume and filter parameters.
9. Create a wavetable and use it in a track.
10. Close the browser and reopen the project without losing work.
11. Undo mistakes reliably.
12. Understand the exact pitch/time of the cursor.

That is the product's real foundation. Playback and export should be layered on top of it rather than allowed to determine the editor architecture.

# 71. Acceptance criteria for the added map, tuning, and wavetable features

The new systems are considered complete when a user can:

1. Switch from Piano Map to Frequency Map without altering curve frequencies.
2. Use Frequency Map in logarithmic and linear-Hz modes.
3. Enable a piano/scale overlay on Frequency Map without changing raw-Hz behavior.
4. Create a custom scale from degree ratios or cents.
5. Change root and scale for snapping.
6. Insert Master Musical State keyframes that change root/scale/tuning over time.
7. Keep an absolute-Hz track immune to those scale changes.
8. Create a scale-relative track that follows those changes.
9. Enable Static JI and see exact rational target frequencies.
10. Enable Dynamic JI and change its explicit anchor context so ratio targets move correctly.
11. See TET/ JI cents deviations during editing.
12. Open the Shape Editor and draw a wavetable frame.
13. Open the Harmonic Editor and edit at least 32 harmonic columns without UI lag.
14. Change any harmonic independently between sine, saw, square, and triangle.
15. Set each harmonic's phase and amplitude independently.
16. See the harmonic fraction/ratio at the bottom of every column.
17. Morph between harmonic-authored frames.
18. Save/reload the wavetable while preserving its editable source representation.

These should become regression tests before advanced audio features are layered on.
