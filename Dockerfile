FROM --platform=${BUILDPLATFORM} node:22@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7 AS build

ARG EXCALIDRAW_REF=a2ec2889babf7d2295469c6d90ebe77fae57df84

WORKDIR /opt/node_app

RUN git init . \
    && git remote add origin https://github.com/excalidraw/excalidraw.git \
    && git fetch --depth 1 origin "${EXCALIDRAW_REF}" \
    && git checkout --detach FETCH_HEAD \
    && rm -rf .git \
    && rm -f .env.development .env.production .npmrc

COPY patches/excalidraw-home.patch /tmp/excalidraw-home.patch

COPY patches/excalidraw-home.patch /tmp/excalidraw-home.patch

RUN git apply --unidiff-zero --check /tmp/excalidraw-home.patch \
    && git apply --unidiff-zero /tmp/excalidraw-home.patch \
    && rm /tmp/excalidraw-home.patch

RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production
ARG VITE_APP_PLUS_LP=https://plus.excalidraw.com
ARG VITE_APP_PLUS_APP=https://plus.excalidraw.com

RUN VITE_APP_PLUS_LP=${VITE_APP_PLUS_LP} \
    VITE_APP_PLUS_APP=${VITE_APP_PLUS_APP} \
    npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

HEALTHCHECK CMD wget -q -O /dev/null http://127.0.0.1 || exit 1
