# Excalidraw Home

A self-hosted Excalidraw v0.18.1 instance with named server drawings, autosave, recent files, and a searchable drawing manager. This repository contains the deployment, API, and focused customization patch; the upstream Excalidraw source is fetched at build time.

## Run with Docker Compose

1. Copy `.env.example` to `.env`.
2. Set `EXCALIDRAW_DATA_DIR` to an absolute host directory with write access for UID/GID `1000:1000`.
3. Start the app:

   ```sh
   docker compose up -d --build
   ```

The web app listens on `127.0.0.1:5002`. Nginx supports the `/excalidraw` subpath and proxies file operations to the API container. The existing Tailscale Serve route can continue forwarding that subpath to this port.

Drawing files and generated PNG thumbnails are stored in `EXCALIDRAW_DATA_DIR`, outside this repository. Keep that directory backed up and do not commit its contents.

## Features

- Autosaves named drawings to host files with revision-conflict detection.
- Lists recent drawings in the Excalidraw menu.
- Provides a searchable manager with previews, open, rename, and delete actions; existing drawings get previews when the manager is first opened.
- Keeps the focused application patch, file API, and Docker/Nginx deployment configuration together.

## Source

`patches/excalidraw-home.patch` applies the self-hosting customizations to the public Excalidraw repository at commit `a2ec2889babf7d2295469c6d90ebe77fae57df84` (tag `v0.18.1`). The build fetches that exact upstream commit; the upstream source itself is not stored in this repository. The API is a small Bun service in `api/`.
