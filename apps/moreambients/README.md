# MoreAmbients

MoreAmbients is an iDrive 7 canvas app with two ways to change the cabin lighting:

- **BMW palette** requests one of BMW's 12 factory colour slots through `ComfortFunctionIuK` and shows the slot reported by the vehicle.
- **Custom RGB** scans both BDC ambient-light buses first, then writes only to the healthy modules returned by that scan. The colour wheel, saturation, brightness, all/upper/lower zone choice, and six saved looks are included.

Custom RGB changes are static and held for 60 seconds at a time. While the app is running, the hold is renewed every 40 seconds. Restore BMW Lighting sends each discovered module the release request, which returns it to the car's own colour. If the app stops unexpectedly, the short hold expires by itself. A missing or stale vehicle-speed signal blocks colour changes; the car must be stationary.

The RGB path is based on the public BMW BDC_G05 ambient LIN descriptions and the G20-capable `ambient_config` and `gs_ambient` implementations included in the user's AQ_MGU source collection. It does not use guessed module addresses, flashing effects, or unverified module responses. A positive BDC acknowledgement means the request was accepted; it does not prove the LED visibly changed. Hardware support must be confirmed in the vehicle.

Factory colour slot numbers have vehicle-specific colours. The app therefore displays slot numbers, not promised colour names. BMW's ambient-light system must be enabled in the vehicle for those slots to be visible.

## Upstream notice

The factory-colour request fields and ambient BDC/LIN protocol were studied from `idrive7-apps/apps/ambient_config` (MIT; copyright cauliflowermossgrape and 小白151) and `tjmodsss-tjm-apps/apps/gs_ambient` in the AQ_MGU source collection. This app's UI, state handling, and command flow are original MoreAmbients code. See `UPSTREAM-NOTICE.md` for the MIT notice.
