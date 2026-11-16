# Sound set v4 ("mecha"): sources and licence

The `sfx-*.mp3` (event sounds) and `loop-*.mp3` (background loops) files in this folder are our own mixes, built by
`scripts/sounds/build.mjs` from the recipe list `scripts/sounds/recipes.mjs`. They are **modified** versions of
samples from the pack below: trimmed, pitch-shifted, layered, levelled and, for the loops, folded into seamless loops.

## Credit

**"Free Cinematic Sound Effects"** by **Gregor Quendel**, licensed under
**CC BY 4.0** (Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/).
Modified. Source: https://opengameart.org/content/free-cinematic-sound-effects
(archive `gregor_quendel_-_free_cinematic_sound_effects_-_mp3.zip`).

The same credit is shown in the app, under the volume slider of the sound settings.

The unmodified source files the recipes use are committed in `scripts/sounds/sources/gregor-quendel/` with a
`LICENSE.txt`; the build refuses the pack when that file does not name CC BY 4.0. The SHA-256 of every source file
is in `web/lib/sound/sample-report.json` (`sources`).

## Files used, per sound

| Our file | Plays for | Source files (`scripts/sounds/sources/gregor-quendel/`) |
|---|---|---|
| `sfx-decision_open.mp3` | Decision waiting | Mecha_Elements_Impact_01.mp3, Circuits_Ambience_Burst_01.mp3, Mecha_Sequences_Mechanisms_01.mp3 |
| `sfx-task_blocked.mp3` | Task blocked | Sci-Fi_Circuits_Error_RobotSpeech.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-tool_error.mp3` | Tool error | Sci-Fi_Tuner_Chaoswhip_02.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-session_start.mp3` | Session started | Fire_Swooshes_Burst_Evolving_19.mp3, Mecha_Sequences_Mechanisms_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-stage_done.mp3` | Stage done | Mecha_Sequences_Mechanisms_01.mp3, Fire_Impacts_Complex_04.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-task_start.mp3` | Task started | Mecha_Sequences_Mechanisms_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-task_review.mp3` | Task to review | Mecha_Elements_Mechanism_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-task_done.mp3` | Task done | Mecha_Elements_Mechanism_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-decision_answered.mp3` | Decision answered | Mecha_Sequences_Mechanisms_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-agent_spawn.mp3` | Agent spawned | Mecha_Sequences_Mechanisms_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-agent_complete.mp3` | Agent finished | Mecha_Sequences_Mechanisms_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-agent_offboarded.mp3` | Instance offboarded | Mecha_Sequences_Mechanisms_01.mp3, Mecha_Elements_Impact_01.mp3 |
| `sfx-tool_start.mp3` | Tool start | Mecha_Sequences_Mechanisms_01.mp3 |
| `sfx-tool_complete.mp3` | Tool finished | Mecha_Elements_Impact_01.mp3 |
| `sfx-handoff.mp3` | Handoff / message | Mecha_Sequences_Mechanisms_01.mp3 |
| `loop-owner.mp3` | "Butuh jawaban owner" (a decision is open) | Mecha_Elements_Impact_01.mp3 |
| `loop-waiting.mp3` | Waiting for permission | Mecha_Sequences_Mechanisms_01.mp3 |
| `loop-thinking.mp3` | Thinking | Mecha_Sequences_Ambience_06.mp3, Circuits_Hum_06.mp3 |
| `loop-disintegrating.mp3` | Finished sub-agent wearing away | Plastic_Elements_Creaking_04.mp3, Rocks_Elements_09.mp3 |

Each loop file holds two identical loop periods; the app loops one period from the middle of the first to the
middle of the second, so the seam never touches the MP3's encoder delay or padding.

## Levels

Targets (loudness, LUFS: the EBU R128 momentary maximum, or the whole length for sounds under 400 ms): alerts -14
(`decision_open`, `task_blocked`, `tool_error`), milestones -18, frequent -20 (`tool_start`, `tool_complete`,
`handoff`); loops owner -20, waiting -21, disintegrating -26, thinking -28. True peak at most -1 dBTP. The build
fails when a file is more than 1.5 LU off its target.

## Rebuild

Needs ffmpeg with libmp3lame on PATH. The sources are in the repo, so no download is needed:

```
node scripts/sounds/build.mjs            # writes web/public/sounds/*.mp3 and web/lib/sound/sample-report.json
node scripts/sounds/build.mjs --check    # only checks the report's levels
```

## Earlier sets

Sound set v3 (13 to 16 Nov 2026) used Kenney's CC0 "Sci-Fi Sounds" and "Interface Sounds"; none of those files are
used any more.
