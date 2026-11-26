# cluster-render (vendored)

Unmodified files of the **cluster-render** service, release `cluster-render@0.8.14`, from
<https://github.com/robertnisipeanu/idrive-apps> (`native/cluster-render`, GPL-3.0-or-later -
see `LICENSE`).

The service draws apps' layers on the instrument cluster (`panel`, 1920x720), the central
map area (`map`) and the head-up display (`hud`). Apps talk to it over
`/dev/shm/cluster-render/render.sock` (`cluster_render_client.js`), which the
`cluster-render.socket` unit creates with group `tm_oap_app` - every OAP app may connect.

It is vendored so the mgu Store can install it from this repository's own source
(`mgu-repo.json` -> `tools`). `apps/vclusters` declares it in `requires`: the Store installs
the service before the app, like `idrive7-renderd` for the centre screen.

Contents, as shipped in the release tarball (`component.json`, `files/`, `units/`, laid flat
the way `deploy/hu artifact` expects a tool folder):

- `cluster-render` - launcher picking the unit's backend
- `cluster-render-idrive7`, `cluster-render-idrive8` - the service binaries
- `cluster-render.conf` - service configuration
- `cluster_render_client.js`, `cluster_render_text.js` - the Node 8 clients
- `cluster-render.service`, `cluster-render.socket` - the systemd units
- `component.json` - the tool manifest
