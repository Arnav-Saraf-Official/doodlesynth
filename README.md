# Doodlesynth

A static SvelteKit 5 / TypeScript instrument for drawing continuous pitch curves. Model pitch stays in Hz; sound design does not rewrite the curves.

## Develop and verify

```sh
bun install
bun run dev
bun run check
bun run lint
bun test
bun run build
node scripts/sound-browser.mjs
```

The browser/audio test uses Chrome at the default Windows installation path. It serves the production build locally, uses a fresh temporary browser profile, measures Web Audio output, and closes the browser/server afterward.

## Sound designer

Open **Sounds** (`/sounds`) from the editor. Choose a sound in the project library, or create an initialized sound. Tracks select **sound profiles**, not wavetables. A profile is shared: editing it updates every linked track. Use **Save as copy** for independent variations. Profiles and their wavetable assets are saved with the project and participate in undo/redo.

- **Starter library:** open **Start from a sound** and add Round sub, Slow bloom, Glass pluck, Wide lead, Drawbar organ or Echo keys. These original patches create independent editable sounds without replacing linked tracks. Assign one explicitly with **Load into…**.
- **Library organization:** star the selected sound, toggle **Favorites**, filter by category, or search names and categories together. Edit **Sound category** to organize your own patches. Favorites/categories save with the project and support undo/redo; **Clear filters** recovers an empty search.
- **Voice:** three oscillators, generated white-noise layer, independent source routing into two parallel Web Audio biquad filters or directly into the effect rack. Oscillators have level, pan, transpose, fine tune, wavetable position and unison.
- **Effects:** reorderable chorus, single-band compressor, tanh distortion, three-band EQ, low-pass filter, flanger, four-stage phaser, delay and stereo convolution reverb. Enable a module before adjusting it. Drag its numbered handle or use the keyboard-accessible up/down buttons.
- **Delay:** mono, stereo and **ping-pong (PiPo)**, independent stereo timing, free seconds or fractional-beat tempo sync, feedback (capped at 95%), low/high-cut feedback filtering, wet/dry mix and stereo width. For example, 0.75 beats is a dotted eighth; 1/3 beat is an eighth-note triplet.
- **Matrix:** editable/bypassable LFO and attack/decay envelope connections. Envelope triggers come from curve starts or pitch stabilization after a steep change, not transport starts. Wavetable-position modulation affects all wavetable oscillators.
- **Advanced:** oscillator start phase/randomization and unison phase/stereo spread, plus resource/quality limits.
- **Wavetable:** oscillator asset selection and embedded harmonic/shape editors. The original `/wavetables` route remains the full asset library for frame management, conversion and utilities.
- **Audition:** the on-screen keyboard and Space play a 1.5-second note through the same patch graph as timeline playback; Escape/Stop stops it. Key highlighting clears at note-off while release and effect tails continue; canceled audio startup cannot restart a stopped note. The output display switches between a real oscilloscope and spectrum.

Existing projects migrate each track's old synth/modulation into a profile without changing curve points, individual curve ADSR, mixer settings or automation. A patch ADSR is optional: until enabled, existing curves retain their own envelopes. The profile's output level is separate from the track mixer.

### Engine boundaries

Unison supports 1–16 copies per oscillator, spread symmetrically in cents with gain normalized by `1 / copies`. This is peak-safe, not a constant-RMS loudness compensation algorithm. Detuned copies can sound quieter than perfectly correlated copies. Explicit phase spread can intentionally cancel identical zero-detune waveforms; the initialized phase spread is zero. Random phase is deterministic per curve so graph rebuilds do not randomize it again.

Playback admits at most 64 musical curves and 256 oscillator/noise source nodes; curves that cannot fit a complete stack are omitted. Wavetable playback uses a Web Audio periodic-wave approximation with 128 partials and 65 morph positions. This is not Vital's spectral engine. Morph updates are control-rate; modulation is scheduled with short linear ramps, not sample-accurate DSP.

Not implemented: sample playback, spectral warping, oscillator FM/RM, custom LFO curves, drag-to-assign modulation, macros/random generators, MPE, DAHDSR hold/delay, serial/dual-filter routing, multiband/OTT compression, or general synth oversampling. The UI does not present these as working features.

## Vital preset conversion

**Import .vital** accepts standard Vital **1.x JSON** presets up to 16 MB. Conversion produces an editable Doodlesynth sound and shows persistent compatibility notes. It is **best-effort conversion, not native or identical-sounding playback**.

Supported subset:

- Three oscillator enable states, level (Vital's quadratic value), pan, transpose, fine tune, phase/randomization, wavetable position and bounded unison.
- Embedded `Wave Source` float32 keyframes (up to 64 per oscillator), converted to editable 128-partial harmonic frames. Only the first Wave Source is used; extra groups/modifiers are explicitly reported.
- Envelope 1 ADSR times (Vital's quartic encoding) and sustain.
- Approximate low-pass voice filters, tanh distortion, three-band EQ, stereo convolution reverb and delay free-time settings.

Unsupported wavetable sources fall back to saw **with a warning**. Vital spectral/FM processing, samples, modulation assignments, synced-delay decoding, custom filter models, effect order and advanced performance settings are not imported. Unsupported effects are left disabled. No factory Vital presets are bundled or redistributed.

Format research used Vital's published serializer, parameter definitions and wavetable source structure; no Vital DSP source was copied into this project:

- [Vital repository and licensing/content restrictions](https://github.com/mtytel/vital)
- [Preset serialization](https://github.com/mtytel/vital/blob/main/src/common/load_save.cpp)
- [Parameter units and encodings](https://github.com/mtytel/vital/blob/main/src/common/synth_parameters.cpp)
- [Embedded waveform format](https://github.com/mtytel/vital/blob/main/src/common/wavetable/wave_source.cpp)
- [Wavetable creator structure](https://github.com/mtytel/vital/blob/main/src/common/wavetable/wavetable_creator.cpp)
