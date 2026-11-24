# VKP DEV-SCAN

An iDrive 7 catalog browser for discovering which locally described interfaces relate to a vehicle feature.

## Use

- Select one of the nine feature tabs: ambient lighting, route guidance, GPS, media, climate, exterior lights, doors, drive modes, or fuel.
- Browse every matching interface with **More**. Touch a row or choose **Details** to inspect its fields, methods, broadcasts, and types.
- In the detail view, **More** pages through members. **Back** returns to the result list. **Next match** moves to the next interface and returns to the list after the final result.
- **Save report** writes `vkp-devscan-report.txt` to the app data folder. The same report is refreshed when the app starts.
- Choose VKP Red, M Tricolour, Ice White, or Night Amber in Settings.

## Data and safety

The scanner reads `/etc/oap/someip/someip-interfaces.json` and lists JSON filenames in `/usr/lib/oap-mainapp/src-gen`. It does not connect to a vehicle service, subscribe to live signals, or send vehicle commands. The catalog can differ by head-unit software and vehicle equipment, so a missing match means it was not found in those local descriptions.
