# Vosk speech models

Drop Vosk speech-recognition models in this folder. They are used by the STT
pipeline to transcribe intercepted TTS audio and produce word-level timestamps
for lip-sync.

## How to add a model

1. Download a model archive from <https://alphacephei.com/vosk/models>
   (the small English model `vosk-model-small-en-us-0.15` is a good default).
2. Vosk Browser loads a **`.tar.gz`** archive of the model folder. If you
   downloaded a `.zip`, repack the extracted model directory as `.tar.gz`, e.g.:

   ```bash
   tar -czf vosk-model-small-en-us-0.15.tar.gz vosk-model-small-en-us-0.15
   ```

3. Place the resulting `.tar.gz` in this folder.
4. In the extension settings, set **Vosk model URL** to the served path, e.g.:

   ```
   /scripts/extensions/third-party/Extension-Live2D-Plus/models/<your-model>.tar.gz
   ```

   Leave the field empty to use the bundled default
   (`vosk-model-small-en-us-0.15.tar.gz`).

The folder is served by SillyTavern at
`/scripts/extensions/third-party/Extension-Live2D-Plus/models/`.
