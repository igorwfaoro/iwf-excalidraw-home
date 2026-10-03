# Server Drawings Flow
> Named Excalidraw scenes persisted as host files

Entry: `patches/excalidraw-home.patch` (applied to the pinned upstream source during image build)
Flow: menu/dialog → patched Excalidraw frontend → Nginx `/api/files` proxy → `api/server.js` → `DATA_DIR`

- Autosave: debounced scene JSON + PNG thumbnail; API uses revision checks and per-file locks
- Manager: `ServerFilesDialog` is included in the focused patch; legacy previews are backfilled revision-safely, rename increments revision, delete removes scene and thumbnail
- Deployment: `docker-compose.yml` keeps project name `excalidraw` and binds `EXCALIDRAW_DATA_DIR` outside the repo
- Build pins upstream commit `a2ec2889babf7d2295469c6d90ebe77fae57df84`; root `nginx.conf` supports `/excalidraw`; Tailscale Serve forwards the existing URL to localhost port 5002

Updated: 2026-10-03
