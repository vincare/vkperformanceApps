# MoreAmbients

MoreAmbients is an iDrive 7 canvas app with three lighting views:

- **OEM** follows the BMW ambience layout. Its 36 named colour choices are sent immediately when selected; no separate Apply step is needed. Background and accent brightness are separate for discovered lower and upper zones. Night reduction dims both zones.
- **BMW palette** requests one of BMW's 12 factory colour slots through `ComfortFunctionIuK` and shows the slot reported by the vehicle.
- **Colour Studio** offers custom RGB, brightness, zone choice, and six saved looks.

The app reads the vehicle speed and automatically scans both BDC ambient-light buses when it starts. It writes only to healthy modules returned by that scan. Custom RGB changes are held for 60 seconds and renewed every 40 seconds while the app is running. Restore BMW Lighting sends each discovered module a release request, returning control to the car. If the app stops unexpectedly, the short hold expires by itself. Colour and brightness changes require a fresh speed signal and a stationary vehicle.

The OEM on/off switch sends BMW's ambient brightness request (zero to turn off, full brightness to turn on) without requiring a speed signal, whether the vehicle is moving or stopped. The switch updates immediately, queues repeated taps while a request is in flight, and retries a tap received during the automatic module scan. When discovered RGB modules are available, OFF also sends and renews a zero-brightness command to keep those modules dark while the app is running; ON releases a previous module override. The cabin preview removes the blue ambient glow while OFF and restores the original photo when ON. Turning the lights back on replaces the module override with the selected look. The night reduction is an app-controlled dimming preset, not an automatic light sensor.

The RGB path is based on the public BMW BDC_G05 ambient LIN descriptions and the G20-capable `ambient_config` and `gs_ambient` implementations included in the user's AQ_MGU source collection. It does not use guessed module addresses or flashing effects. A positive BDC acknowledgement means the request was accepted; it does not prove the LED visibly changed. If no RGB modules are discovered, custom colours remain unavailable and the car's lighting is left unchanged. Hardware support must be confirmed in the vehicle.

Factory colour slot numbers have vehicle-specific colours. The app therefore displays slot numbers, not promised colour names. BMW's ambient-light system must be enabled in the vehicle for those slots to be visible.

## Upstream notice

The factory-colour request fields and ambient BDC/LIN protocol were studied from `idrive7-apps/apps/ambient_config` (MIT; copyright cauliflowermossgrape and 小白151) and `tjmodsss-tjm-apps/apps/gs_ambient` in the AQ_MGU source collection. This app's UI, state handling, and command flow are original MoreAmbients code. See `UPSTREAM-NOTICE.md` for the MIT notice.
