# MoreAmbients

MoreAmbients is an iDrive 7 canvas app with three lighting views:

## 0.2.14

- Diagnostic operations now use the initialized TASU proxy even if the head unit's `available` notification is late or reports false during startup. The previous gate could prevent the module scan and every direct RGB/zone/restore command from being sent.
- Ambient-module discovery retries BMW's confirmed UDS `BUSY` response and uses AmbientConfig's read-only BDC-address fallback when the default address does not answer. RGB writes and restore requests use the same transport retry settings as AmbientConfig.
- UI, factory signal payloads, module mapping, RGB byte order, and all other lighting modes are unchanged. The app still reports acknowledgements, which do not prove that an LED visibly changed; an in-car check is required.

- **OEM** follows the BMW ambience layout. Its 36 named colour choices are sent immediately when selected; no separate Apply step is needed. Background and accent brightness are separate for discovered lower and upper zones. Night reduction dims both zones.
- **BMW palette** requests one of BMW's 12 factory colour slots through `ComfortFunctionIuK` and shows the slot reported by the vehicle.
- **Colour Studio** offers custom RGB, brightness, zone choice, and six saved looks. Applying a Studio colour now saves the exact colour and target zones for reliable reapplication after a rescan or app restart.
- **Zones** stores independent dashboard, door and footwell colours. Combos can colour all lights, only the dashboard and doors, or only the footwells; each option previews the relevant combo colour.

A single colour selected from either palette is applied to every discovered healthy light module, regardless of the last zone selected. To keep different dashboard, door and footwell colours, turn on **Ambient Zones Lighting** and edit each zone there. Picking a global colour or combo exits that zone override so a later scan cannot restore stale zone colours. M Color maps BMW's module locations so only door-handle modules use `#003D78`; the illuminated door strips follow the dashboard colour, and the four footwell modules use `#E22718`.

The first screen is drawn before vehicle diagnostics start, so its controls appear while the two BDC ambient-light buses are scanned in the background. A colour selected before scanning finishes is queued and applied to the latest selection after the scan. The app writes only to healthy modules returned by that scan. RGB writes are serialized, rapid changes are coalesced to the latest selection, and a bus-wide default colour is followed by individual zone overrides to reduce delay. Custom RGB changes are held for 60 seconds and renewed every 40 seconds while the app is running. The factory brightness refresh is paused while a direct LIN look is active, so it cannot overwrite per-zone colour or brightness. Temporary write failures are retried without dropping the selected look. Colour and brightness changes work while moving or stopped; the app does not wait for a speed signal before applying or restoring a look. Restore BMW Lighting sends a release request to each bus; if the app stops unexpectedly, the active hold expires by itself.

The OEM panel also has optional automatic colour features. Comfort, Sport, and Eco can be armed independently; the selected colour is sent only when the matching live FES driving mode is reported. M Color applies dashboard and trim `#0066B1` (RGB 0, 102, 177), the four door-handle modules `#003D78` (RGB 0, 61, 120), and the four footwell modules `#E22718` (RGB 226, 39, 24) simultaneously. The UI swatches and BDC payloads use the same HEX values; channel brightness is sent separately from RGB. Turning M Color off releases the LIN modules back to BMW lighting and restores the factory slot reported before M Color, when available. These automatic mode commands can follow a mode change while driving. Choosing a manual Color, Combo, BMW palette colour, or Studio Apply turns the automatic features off. M Color is exclusive with the three driving-mode options.

The OEM on/off switch sends BMW's ambient brightness request (zero to turn off, full brightness to turn on) without requiring a speed signal, whether the vehicle is moving or stopped. The switch updates immediately, queues repeated taps while a request is in flight, and retries a tap received during the automatic module scan. When discovered RGB modules are available, OFF also sends and renews a zero-brightness command to keep those modules dark while the app is running; ON releases a previous module override. The cabin preview removes the blue ambient glow while OFF and restores the original photo when ON. Turning the lights back on replaces the module override with the selected look. The night reduction is an app-controlled dimming preset, not an automatic light sensor.

The cabin preview is shown without an added blur. The upper colour is limited to the two ambient trim strips, while the lower colour fills the footwell with a soft spill toward its darker left side. Blue reflections on the dashboard surface are neutralised instead of being recoloured.

The RGB path is based on the public BMW BDC_G05 ambient LIN descriptions and the G20-capable `ambient_config` and `gs_ambient` implementations included in the user's AQ_MGU source collection. It does not use guessed module addresses or flashing effects. A positive BDC acknowledgement means the request was accepted; it does not prove the LED visibly changed. If no RGB modules are discovered, custom colours remain unavailable and the car's lighting is left unchanged. Hardware support must be confirmed in the vehicle.

RGB values are preserved exactly where the BDC protocol allows them; the reserved `0xFF` channel value is represented by `0xFE` so it cannot be interpreted as “leave unchanged.” The last selected OEM palette colour is also resolved from its saved palette name after restart.

Factory colour slot numbers have vehicle-specific colours. The app therefore displays slot numbers, not promised colour names. BMW's ambient-light system must be enabled in the vehicle for those slots to be visible.

## Upstream notice

The factory-colour request fields and ambient BDC/LIN protocol were studied from `idrive7-apps/apps/ambient_config` (MIT; copyright cauliflowermossgrape and 小白151) and `tjmodsss-tjm-apps/apps/gs_ambient` in the AQ_MGU source collection. This app's UI, state handling, and command flow are original MoreAmbients code. See `UPSTREAM-NOTICE.md` for the MIT notice.
