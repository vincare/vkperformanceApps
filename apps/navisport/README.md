# NaviSport

NaviSport is a dedicated MGU/iDrive 7 screen with a CarPlay map preview, BMW live
power and torque, vehicle speed, a matching M340i/M440i side view, and the
M SOUND MODE exhaust-valve control.

## CarPlay map preview

The app tries to capture the projected center-screen image with the MGU
winston-grabber utility. It scales a map region into the left panel at a maximum
of about 1.4 frames per second. It does not create or request a second CarPlay
video stream. BMW may make the capture utility unavailable to an app, or the
projected image may no longer be available when NaviSport is in front. In either
case the screen says that a CarPlay frame is unavailable; it does not substitute
a simulated map.

The capture permission and foreground behavior have to be confirmed on the
physical head unit. A successful desktop package build cannot establish that.

## Vehicle values

- Torque uses the same BMW FES signal and raw conversion as PERFORMANCE.
- Horsepower uses the BMW Sport Display percentage and the configured maximum
  power, or torque x RPM when the Sport Display value is unavailable/disabled.
- Torque x RPM and Sport Display scaling are estimates, not a chassis-dyno
  measurement. The source is shown under the value, and the maximum can be
  adjusted in NaviSport Settings.
- Vehicle speed shows 0 km/h when a live zero-speed signal arrives. “--”
  means the car has not supplied a fresh speed signal.

## M SOUND MODE

The button requests OPEN on the first press and OEM control on the second.
Requests use PERFORMANCE's per-DME adapter and the same DME match and arming
gate. NaviSport sends no exhaust command on startup. A DME reply only means the
request was accepted; the app cannot claim the physical valve moved unless the
DME provides a valid position read-back.

## Build

From the repository root:

    python kit/tools/build.py navisport

The installable package is written to dist/navisport@0.1.0.mgu (and the
preinstalled-apps tarball to dist/navisport@0.1.0.tgz).
