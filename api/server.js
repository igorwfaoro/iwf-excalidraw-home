import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fileLocks = new Map();

const jsonResponse = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const errorResponse = (message, status) => jsonResponse({ error: message }, status);

const validateName = (name) =>
  typeof name === "string" && name.trim().length > 0 && name.trim().length <= 100
    ? name.trim()
    : null;

const validateScene = (scene) =>
  scene &&
  typeof scene === "object" &&
  scene.type === "excalidraw" &&
  Array.isArray(scene.elements) &&
  scene.appState &&
  typeof scene.appState === "object" &&
  !Array.isArray(scene.appState);

const safeFileName = (name) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "drawing";

const filePath = (id, name) =>
  path.join(DATA_DIR, `${safeFileName(name)}--${id}.excalidraw`);

const thumbnailPath = (id) => path.join(DATA_DIR, `${id}.png`);

const findFilePath = async (id) => {
  const suffix = `--${id}.excalidraw`;
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  return match ? path.join(DATA_DIR, match.name) : null;
};

const readScene = async (id) => {
  const currentPath = await findFilePath(id);
  if (!currentPath) {
    return null;
  }
  try {
    return { filePath: currentPath, scene: JSON.parse(await readFile(currentPath, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const getSummary = async (id, scene, currentPath) => {
  const fileStat = await stat(currentPath);
  const metadata = scene._serverFile || {};
  let hasThumbnail = false;
  try {
    await stat(thumbnailPath(id));
    hasThumbnail = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    id,
    name: validateName(metadata.name) || "Untitled drawing",
    revision: Number.isInteger(metadata.revision) ? metadata.revision : 0,
    updatedAt: metadata.updatedAt || fileStat.mtime.toISOString(),
    hasThumbnail,
  };
};

const writeThumbnail = async (id, thumbnail) => {
  const destination = thumbnailPath(id);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, thumbnail, { mode: 0o640 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const writeScene = async (
  id,
  scene,
  metadata,
  previousPath = null,
  thumbnail = null,
) => {
  const destination = filePath(id, metadata.name);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ ...scene, _serverFile: metadata }, null, 2)}\n`,
    { mode: 0o640 },
  );
  await rename(temporary, destination);
  if (previousPath && previousPath !== destination) {
    await rm(previousPath, { force: true });
  }
  if (thumbnail) {
    try {
      await writeThumbnail(id, thumbnail);
    } catch (error) {
      console.error("Unable to write drawing thumbnail", error);
    }
  }
};

const parseThumbnail = (value) => {
  if (value === undefined || value === null) {
    return { thumbnail: null };
  }
  if (typeof value !== "string") {
    return { error: "A PNG thumbnail is required" };
  }

  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return { error: "A PNG thumbnail is required" };
  }
  if (match[1].length > Math.ceil((2 * 1024 * 1024 * 4) / 3)) {
    return { error: "Invalid or oversized PNG thumbnail" };
  }

  const thumbnail = Buffer.from(match[1], "base64");
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (
    thumbnail.length < pngSignature.length ||
    thumbnail.length > 2 * 1024 * 1024 ||
    !thumbnail.subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    return { error: "Invalid or oversized PNG thumbnail" };
  }
  return { thumbnail };
};

const readRequestBody = async (request) => {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 100 * 1024 * 1024) {
    throw new Error("Request body is too large");
  }
  return request.json();
};

const withFileLock = async (id, operation) => {
  const previous = fileLocks.get(id) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  fileLocks.set(id, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileLocks.get(id) === current) {
      fileLocks.delete(id);
    }
  }
};

await mkdir(DATA_DIR, { recursive: true });

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT) || 3000,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const match = pathname.match(/^\/api\/files(?:\/([^/]+))?(?:\/(thumbnail))?\/?$/);

    if (!match) {
      return errorResponse("Not found", 404);
    }

    const id = match[1];
    const resource = match[2];

    try {
      if (resource === "thumbnail") {
        if (!id || !FILE_ID_PATTERN.test(id)) {
          return errorResponse("Invalid drawing ID", 400);
        }
        if (request.method === "PUT") {
          const body = await readRequestBody(request);
          const parsedThumbnail = parseThumbnail(body.thumbnail);
          if (parsedThumbnail.error) {
            return errorResponse(parsedThumbnail.error, 400);
          }
          if (!Number.isInteger(body.revision) || !parsedThumbnail.thumbnail) {
            return errorResponse("A valid revision and PNG thumbnail are required", 400);
          }

          return withFileLock(id, async () => {
            const existingRecord = await readScene(id);
            if (!existingRecord || !validateScene(existingRecord.scene)) {
              return errorResponse("Drawing not found", 404);
            }
            const currentRevision = Number.isInteger(
              existingRecord.scene._serverFile?.revision,
            )
              ? existingRecord.scene._serverFile.revision
              : 0;
            if (body.revision !== currentRevision) {
              return errorResponse(
                "Drawing changed on another device; reopen it before saving",
                409,
              );
            }
            await writeThumbnail(id, parsedThumbnail.thumbnail);
            return jsonResponse(
              await getSummary(id, existingRecord.scene, existingRecord.filePath),
            );
          });
        }
        if (request.method !== "GET") {
          return errorResponse("Method not allowed", 405);
        }
        if (!(await findFilePath(id))) {
          return errorResponse("Drawing not found", 404);
        }
        try {
          return new Response(await readFile(thumbnailPath(id)), {
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": "image/png",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          if (error.code === "ENOENT") {
            return errorResponse("Thumbnail not found", 404);
          }
          throw error;
        }
      }

      if (request.method === "GET" && !id) {
        const entries = await readdir(DATA_DIR, { withFileTypes: true });
        const files = [];

        for (const entry of entries) {
          const match = entry.name.match(/--([0-9a-f-]+)\.excalidraw$/i);
          const fileId = match?.[1];
          if (!entry.isFile() || !fileId || !FILE_ID_PATTERN.test(fileId)) {
            continue;
          }
          const record = await readScene(fileId);
          if (record && validateScene(record.scene)) {
            files.push(await getSummary(fileId, record.scene, record.filePath));
          }
        }

        files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return jsonResponse(files);
      }

      if (request.method === "POST" && !id) {
        const body = await readRequestBody(request);
        const name = validateName(body.name);
        if (!name || !validateScene(body.scene)) {
          return errorResponse("A valid name and Excalidraw scene are required", 400);
        }
        const parsedThumbnail = parseThumbnail(body.thumbnail);
        if (parsedThumbnail.error) {
          return errorResponse(parsedThumbnail.error, 400);
        }

        const newId = crypto.randomUUID();
        const metadata = {
          name,
          revision: 1,
          updatedAt: new Date().toISOString(),
        };
        await writeScene(newId, body.scene, metadata, null, parsedThumbnail.thumbnail);
        const createdRecord = await readScene(newId);
        return jsonResponse(
          await getSummary(newId, createdRecord.scene, createdRecord.filePath),
          201,
        );
      }

      if (!id || !FILE_ID_PATTERN.test(id)) {
        return errorResponse("Invalid drawing ID", 400);
      }

      if (request.method === "GET") {
        const record = await readScene(id);
        if (!record || !validateScene(record.scene)) {
          return errorResponse("Drawing not found", 404);
        }
        const summary = await getSummary(id, record.scene, record.filePath);
        const scene = record.scene;
        const { _serverFile, ...sceneData } = scene;
        return jsonResponse({ ...summary, scene: sceneData });
      }

      if (request.method === "PUT") {
        const body = await readRequestBody(request);
        const name = validateName(body.name);
        if (!name || !validateScene(body.scene) || !Number.isInteger(body.revision)) {
          return errorResponse("A valid name, revision, and Excalidraw scene are required", 400);
        }
        const parsedThumbnail = parseThumbnail(body.thumbnail);
        if (parsedThumbnail.error) {
          return errorResponse(parsedThumbnail.error, 400);
        }

        return withFileLock(id, async () => {
          const existingRecord = await readScene(id);
          if (!existingRecord || !validateScene(existingRecord.scene)) {
            return errorResponse("Drawing not found", 404);
          }

          const currentRevision = Number.isInteger(
            existingRecord.scene._serverFile?.revision,
          )
            ? existingRecord.scene._serverFile.revision
            : 0;
          if (body.revision !== currentRevision) {
            return errorResponse("Drawing changed on another device; reopen it before saving", 409);
          }

          const metadata = {
            name,
            revision: currentRevision + 1,
            updatedAt: new Date().toISOString(),
          };
          await writeScene(
            id,
            body.scene,
            metadata,
            existingRecord.filePath,
            parsedThumbnail.thumbnail,
          );
          const savedRecord = await readScene(id);
          return jsonResponse(
            await getSummary(id, savedRecord.scene, savedRecord.filePath),
          );
        });
      }

      if (request.method === "PATCH") {
        const body = await readRequestBody(request);
        const name = validateName(body.name);
        if (!name) {
          return errorResponse("A valid name is required", 400);
        }

        return withFileLock(id, async () => {
          const existingRecord = await readScene(id);
          if (!existingRecord || !validateScene(existingRecord.scene)) {
            return errorResponse("Drawing not found", 404);
          }

          const currentRevision = Number.isInteger(
            existingRecord.scene._serverFile?.revision,
          )
            ? existingRecord.scene._serverFile.revision
            : 0;
          const metadata = {
            name,
            revision: currentRevision + 1,
            updatedAt: new Date().toISOString(),
          };
          await writeScene(id, existingRecord.scene, metadata, existingRecord.filePath);
          const renamedRecord = await readScene(id);
          return jsonResponse(
            await getSummary(id, renamedRecord.scene, renamedRecord.filePath),
          );
        });
      }

      if (request.method === "DELETE") {
        return withFileLock(id, async () => {
          const existingPath = await findFilePath(id);
          if (!existingPath) {
            return errorResponse("Drawing not found", 404);
          }
          await rm(existingPath, { force: true });
          await rm(thumbnailPath(id), { force: true });
          return jsonResponse({ id });
        });
      }

      return errorResponse("Method not allowed", 405);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return errorResponse("Invalid JSON", 400);
      }
      if (error.message === "Request body is too large") {
        return errorResponse(error.message, 413);
      }
      console.error(error);
      return errorResponse("Internal server error", 500);
    }
  },
});
