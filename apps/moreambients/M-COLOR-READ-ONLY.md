# MoreAmbients · M Color investigation

This release is the read-only discovery stage for M Color. The M Color row opens a diagnostic page; it does not activate an M palette or send color, brightness, profile, LIN, or BDC write requests. While that page is open, MoreAmbients pauses its own ambient keep-alive, brightness retry, automatic-mode sync, queued colour apply, and temporary LIN renewal. An already applied short BDC override is not forcibly released during this read-only session; wait for it to expire before comparing factory-menu changes.

## Source schema

The values below were extracted from the supplied `someip-interfaces (2).json`.

### `de.bmw.infotainment.misc.ComfortFunctionIuK`

- Service ID `46354` (`0xB512`), interface version `1.1`, instance `1`.
- `ambientLightInteriorColour`: getter ID `0`, setter ID `26` (`0x001A`), no notifier; aggregate type `ControlAmbientLightInteriorColourWrapper`.
- `statusAmbientLightInteriorColour`: getter ID `3` (`0x0003`), notifier ID `32771` (`0x8003`), event group `1`, no setter; aggregate type `StatusAmbientLightInteriorColourWrapper`.
- Both fields use instance ID `1`. The schema does not mark the control setter reliable; the status getter and notifier are also marked `reliable: false`.
- Control and status members are aggregate fields, not independent SOME/IP fields or setters:
  - Hue: `UInt16`, default `4095`.
  - `control/statusHueValueLayer1IndividualGroup`, Layer 2 and Layer 3: each `UInt8`, default `255`.
  - Brightness offset: `UInt8`, default `255`.
  - Menu selection: `AMBIENTEBELEUCHTUNG_AUS=0`, `FARBAUSWAHL_1..12=1..12`, `INDIVIDUALMODUS=13`, `KOPPLUNG_AN_FES=14`, `SIGNAL_UNBEFUELLT=15`.
  - Interior-light mode and `controlDynamicInteriorLighting`: `AUS=0`, `EIN=1`, `SIGNAL_UNBEFUELLT=3`.
  - `controlDynamicAmbienteInteriorLighting`: same values `0`, `1`, and `3`.

The schema establishes the UInt8 container range only. It does not define layer values as RGB, BGR, HSV hue, a color index, or a factory-profile ID. It does not document which layer maps to dashboard, door handles, or footwell, nor an independent saturation, brightness, scaling, or gamma transform. Default `255` is recorded as-is; the diagnostic observes what the car returns rather than assuming it is a color.

### `de.bmw.body.interiorillumination.AmbientLight`

- Service ID `45214` (`0xB09E`), interface version `1.0`, instance `1`.
- `mModeAmbientLightActive`: getter `10`, setter `21`, notifier `32772` (`0x8004`), event group `1`.
- `currentInteriorLightProfile`: getter `29`, setter `6`, notifier `32773` (`0x8005`), event groups `1,2`; type is a struct containing `currentLightProfileId`.
- `brightnessAmbientLight`: getter `23`, setter `24`, notifier `32791` (`0x8017`), event groups `1,2`.
- `brightnessAmbientContourLine`: getter `25`, setter `26`, notifier `32793` (`0x8019`), event group `1`.
- `ambientLightActive`: getter `3`, setter `4`, notifier `32771` (`0x8003`), event groups `1,2`.
- Profile enum: `NONE=0`, `COLOUR1..COLOUR50=1..50`, and `MODE0..MODE20=80..100`.
- All five fields use instance ID `1`; the listed getters/notifiers/setters are marked `reliable: false` in the schema.

MoreAmbients declares these AmbientLight fields read-only (`rs`) and never calls their setters. Their brightness values are shown raw; the schema does not establish a conversion to a user percentage.

## Why arbitrary M colors are not sent yet

The existing M Color implementation used BDC LIN writes (`2E DA5E` / `2E E3D1`) and inferred a physical-zone map from module locations. That code path has no confirmed on-car mapping for this HU_MGU/G20, so it is no longer reachable from the M Color row. The `ComfortFunctionIuK` aggregate offers three byte-sized layer values but the supplied schema alone cannot establish how to encode three independent RGB colors. Converting the requested HEX values, swapping RGB/BGR, or guessing gamma/brightness now would still be an unverified command.

The diagnostic page watches the OEM status aggregate and optional AmbientLight profile/brightness only. It shows the target BMW colors as **not sent**, the raw returned values, service availability, observations while the user changes colors in the BMW menu, errors, and the explicitly unknown layer-to-zone map. The refresh button restarts only those read-only watchers. No BDC fallback is activated.

## Reference comparison and license handling

- `Ambient Config` (MIT) uses the factory color-slot aggregate and leaves the layer/hue/brightness controls at their unfilled defaults; it does not provide evidence that these three layers are arbitrary RGB channels. Reference: <https://github.com/cauliflowermossgrape/idrive7-apps/tree/main/apps/ambient_config>.
- `Ambient Drive` (MIT) configures color choices by driving mode; its inspected implementation uses the app's shared client/UI model and does not establish a per-zone RGB SOME/IP payload. Reference: <https://github.com/dorindumitras/ambient-drive>.
- `G21 Ambient Lighting` (GPL-3.0) separates factory BMW color-slot control from its experimental BDC LIN test and displays optional read-only profile/brightness diagnostics. Its G21 observations are not proof of the G20's module map. No GPL code was copied. Reference: <https://github.com/NamelsMissing/mgu-apps/tree/main/apps/g21_ambient>.

## Vehicle observation steps

Park safely, open **M Color Diagnostics**, wait for the availability fields and initial reads, then change one factory color at a time in BMW's own menu. Wait for the displayed layer/profile values to settle after each change. Record the raw before/after values and the visible zone that changed. Do not infer a mapping from the screen color alone. Send the diagnostic screen values and observations back for analysis; only after the encoding and zone map are supported by those observations should controlled write tests be prepared.
